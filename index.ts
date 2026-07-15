import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
  type ProviderResolveDynamicModelContext,
  type ProviderPrepareDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
  type ProviderThinkingProfile,
  type UnifiedModelCatalogProviderContext,
  type UnifiedModelCatalogEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  validateApiKeyInput,
  type SecretInput,
  type SecretInputMode,
} from "openclaw/plugin-sdk/provider-auth";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  applyAxonhubConfig,
  AXONHUB_DEFAULT_MODEL_REF,
  AXONHUB_DEFAULT_BASE_URL,
  AXONHUB_API_PATH,
  resolveAxonhubConfigBaseUrl,
} from "./onboard.js";
import {
  AXONHUB_BASE_REASONING_PROFILE,
  isAxonhubDeepSeekV4ModelId,
  normalizeAxonhubModelId,
  resolveAxonhubFamily,
  supportsAxonhubMaxThinking,
  supportsAxonhubXHighThinking,
} from "./family-table.js";
import { enrichModel } from "./model-metadata.js";
import type { DiscoveredModel, EnrichedModel } from "./model-types.js";
import { findCachedEnrichedModel, syncAxonhubModels } from "./model-sync.js";
import { registerAxonhubCliCommands } from "./cli.js";
import {
  getAxonhubOpenAIEndpoint,
  normalizeAxonhubInstanceRoot,
} from "./url-helpers.js";
import { registerCodexBridge } from "./codex-bridge.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_MAX_TOKENS = 16384;
const AXONHUB_API_KEY_ENV_VAR = "AXONHUB_API_KEY";
const AXONHUB_DEFAULT_CONTEXT_WINDOW = 200000;
const AXONHUB_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Build the thinking profile for a given AxonHub model.
 *
 * Priority:
 * 1. If the family table matches the model id → use the family's profile
 *    (Claude 4.7 → xhigh+adaptive+max, gpt-5/o3/o4-mini → xhigh+max,
 *    Gemini 3 → xhigh, etc.).
 * 2. Else if `reasoning` is true → return the standard 5-level base profile.
 * 3. Else → return null (no profile, OpenClaw falls back to default).
 *
 * Note: when reasoning=true and the family is not matched, OpenClaw's transport
 * layer auto-downgrades any future xhigh request to high, so users won't hit
 * upstream 400s. Max remains gated by `wrapStreamFn` so it never leaks to
 * unsupported families.
 */
function buildAxonhubThinkingProfile(
  modelId: string,
  reasoning?: boolean,
): ProviderThinkingProfile | null {
  const family = resolveAxonhubFamily(modelId);
  if (family) {
    // Preserve the family's defaultLevel if the family helper set one (Claude
    // adaptive/opus profiles set a default). Otherwise fall back to "low" when
    // the catalog reports the model as a reasoning model.
    if (family.profile.defaultLevel !== undefined) {
      return family.profile;
    }
    return {
      ...family.profile,
      defaultLevel: reasoning ? "low" : undefined,
    };
  }
  if (!reasoning) {
    return null;
  }
  return {
    ...AXONHUB_BASE_REASONING_PROFILE,
    defaultLevel: "low",
  };
}

/**
 * wrapStreamFn helper for DeepSeek V4. Keeps the existing payload-shape
 * wrapper from provider-stream-shared.
 */
function createDeepSeekV4AxonhubThinkingWrapper(ctx: {
  streamFn: Parameters<typeof createDeepSeekV4OpenAICompatibleThinkingWrapper>[0]["baseStreamFn"];
  thinkingLevel: Parameters<typeof createDeepSeekV4OpenAICompatibleThinkingWrapper>[0]["thinkingLevel"];
}) {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn: ctx.streamFn,
    thinkingLevel: ctx.thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === PROVIDER_ID && isAxonhubDeepSeekV4ModelId(model.id),
  });
}

/**
 * Wrapper that injects `reasoning_effort: max` on outgoing payloads for
 * families known to support it. Driven by the family table so coverage stays
 * in one place.
 */
function createOpenAICompatibleMaxThinkingWrapper(ctx: {
  modelId: string;
  streamFn: Parameters<typeof createDeepSeekV4OpenAICompatibleThinkingWrapper>[0]["baseStreamFn"];
  thinkingLevel: Parameters<typeof createDeepSeekV4OpenAICompatibleThinkingWrapper>[0]["thinkingLevel"];
}) {
  if (!ctx.streamFn || ctx.thinkingLevel !== "max" || !supportsAxonhubMaxThinking(ctx.modelId)) {
    return ctx.streamFn;
  }
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
    payload.reasoning_effort = "max";
    if (payload.reasoning && typeof payload.reasoning === "object") {
      (payload.reasoning as Record<string, unknown>).effort = "max";
    }
  });
}

/**
 * Build the optional `compat` block for a model. Only includes
 * `supportedReasoningEfforts` when set (otherwise OpenClaw transport defaults
 * apply).
 */
function buildCatalogCompat(model: DiscoveredModel) {
  if (!model.supportedReasoningEfforts || model.supportedReasoningEfforts.length === 0) {
    return undefined;
  }
  return {
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  };
}

/**
 * Shape an enriched AxonHub model into the catalog-entry object that both
 * `catalog.run` and the stored-config migration path in `auth.run` (via
 * `applyAxonhubConfig`) return. Centralized so those two paths cannot drift.
 *
 * The per-model `api` and `baseUrl` come from `EnrichedModel`, so Gemini,
 * Anthropic, OpenAI Responses, and OpenAI Chat Completions each route to the
 * correct AxonHub protocol endpoint instead of a single hard-coded
 * `openai-completions` transport. Return type is inferred so it stays
 * structurally compatible with `ModelDefinitionConfig`.
 */
function buildAxonhubCatalogModelEntry(m: EnrichedModel) {
  const compat = buildCatalogCompat(m);
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow ?? AXONHUB_DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
    ...(compat ? { compat } : {}),
  };
}

function buildAxonhubCatalogModels(enriched: readonly EnrichedModel[]) {
  return enriched.map(buildAxonhubCatalogModelEntry);
}

/**
 * Resolve the configured AxonHub instance root (no `/v1` suffix) from config,
 * falling back to the default instance. Used to derive credential-scoped cache
 * identity and per-protocol endpoints.
 */
function resolveAxonhubInstanceRoot(config: OpenClawConfig | undefined): string {
  const configuredBaseUrl = resolveAxonhubConfigBaseUrl(config);
  const raw = configuredBaseUrl ?? AXONHUB_DEFAULT_BASE_URL;
  return normalizeAxonhubInstanceRoot(raw);
}

// --- Plugin entry ---

const axonhubPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: PROVIDER_ID,
  name: "AxonHub",
  description: "AxonHub AI Gateway provider plugin - Route requests to 100+ LLM providers",
  register(api) {
    const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
      family: "openai-compatible",
    });

    /**
     * Build a runtime model from an already-enriched record. Used when a warm
     * cache entry exists (protocol family, api, and baseUrl are already
     * resolved).
     */
    function runtimeModelFromEnriched(
      enriched: EnrichedModel,
    ): ProviderRuntimeModel {
      const compat = buildCatalogCompat(enriched);
      return {
        id: enriched.id,
        name: enriched.name,
        api: enriched.api,
        provider: PROVIDER_ID,
        baseUrl: enriched.baseUrl,
        reasoning: enriched.reasoning,
        input: enriched.input,
        cost: { ...enriched.cost },
        contextWindow: enriched.contextWindow ?? AXONHUB_DEFAULT_CONTEXT_WINDOW,
        maxTokens: enriched.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
        ...(compat ? { compat } : {}),
      };
    }

    /**
     * Resolve a dynamic AxonHub model.
     *
     * Prefers a warm cache entry (populated by `prepareDynamicModel` or a prior
     * catalog fetch) so the model carries its real protocol family, `api`, and
     * `baseUrl`. When no cache entry exists, derives a conservative model by
     * enriching a minimal `DiscoveredModel`; this still routes Gemini/Anthropic
     * ids to the correct endpoint via the metadata resolver rather than
     * hard-coding `openai-completions` for every family.
     */
    function buildDynamicAxonhubModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const instanceRoot = resolveAxonhubInstanceRoot(ctx.config);

      // 1. Warm cache hit: use the fully-enriched record.
      const cached = findCachedEnrichedModel(instanceRoot, ctx.modelId);
      if (cached) {
        return runtimeModelFromEnriched(cached);
      }

      // 2. Fallback: enrich a minimal discovered model so protocol routing is
      //    still metadata-driven (id/owner-aware) instead of a hard-coded api.
      const family = resolveAxonhubFamily(ctx.modelId);
      const minimal: DiscoveredModel = {
        id: ctx.modelId,
        name: ctx.modelId,
        reasoning: family !== null,
        vision: false,
        input: ["text"],
        cost: { ...AXONHUB_DEFAULT_COST },
      };
      const enriched = enrichModel(minimal, instanceRoot);
      return {
        ...runtimeModelFromEnriched(enriched),
        contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
      };
    }

    /**
     * Async warm-up for dynamic model resolution. Resolves provider auth via the
     * public provider-auth runtime and forces a discovery refresh so the
     * synchronous `resolveDynamicModel` retry can find the enriched record in the
     * in-memory cache. Best-effort: any failure leaves the conservative fallback
     * in place.
     */
    async function prepareDynamicAxonhubModel(
      ctx: ProviderPrepareDynamicModelContext,
    ): Promise<void> {
      try {
        const instanceRoot = resolveAxonhubInstanceRoot(ctx.config);
        const auth = await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
          cfg: ctx.config,
          profileId: ctx.authProfileId,
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
        });
        const apiKey = auth.apiKey;
        if (!apiKey) return;
        await syncAxonhubModels({
          instanceRoot,
          apiKey,
          profileId: auth.profileId ?? ctx.authProfileId,
          agentDir: ctx.agentDir,
        });
      } catch {
        // Best-effort warm-up; conservative fallback covers failures.
      }
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "AxonHub",
      docsPath: "/providers/axonhub",
      envVars: [AXONHUB_API_KEY_ENV_VAR],
      auth: [
        {
          id: "api-key",
          label: "AxonHub API key",
          hint: "API key from your AxonHub instance",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            // 1. Prompt for base URL
            const baseUrlRaw = await ctx.prompter.text({
              message: "AxonHub instance URL",
              initialValue: AXONHUB_DEFAULT_BASE_URL,
              placeholder: AXONHUB_DEFAULT_BASE_URL,
              validate: (value) => (value?.trim() ? undefined : "Required"),
            });
            const baseUrl = (baseUrlRaw ?? AXONHUB_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

            let capturedSecretInput: SecretInput | undefined;
            let capturedMode: SecretInputMode | undefined;
            const opts = ctx.opts as Record<string, unknown> | undefined;
            const flagValue = normalizeOptionalSecretInput(opts?.axonhubApiKey);
            const resolvedKey = await ensureApiKeyFromOptionEnvOrPrompt({
              token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
              tokenProvider: flagValue
                ? PROVIDER_ID
                : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
              secretInputMode:
                ctx.allowSecretRefPrompt === false
                  ? (ctx.secretInputMode ?? "plaintext")
                  : ctx.secretInputMode,
              config: ctx.config,
              env: ctx.env,
              expectedProviders: [PROVIDER_ID],
              provider: PROVIDER_ID,
              envLabel: AXONHUB_API_KEY_ENV_VAR,
              promptMessage: "Enter your AxonHub API key",
              normalize: normalizeApiKeyInput,
              validate: validateApiKeyInput,
              prompter: ctx.prompter,
              setCredential: async (credentialInput, mode) => {
                capturedSecretInput = credentialInput;
                capturedMode = mode;
              },
            });

            if (!resolvedKey) {
              throw new Error("Missing API key input for AxonHub.");
            }

            // 3. Try to discover models from the AxonHub instance through the
            //    shared sync service (force-refreshes so onboarding always sees
            //    the current instance-visible set). The enriched rows carry the
            //    per-model protocol `api`/`baseUrl`.
            const instanceRoot = normalizeAxonhubInstanceRoot(baseUrl);
            const { models: discovered } = await syncAxonhubModels({
              instanceRoot,
              apiKey: resolvedKey,
              agentDir: ctx.agentDir,
              forceRefresh: true,
            });

            // Pick a good default model: prefer known models, fallback to first discovered
            const PREFERRED_DEFAULTS = ["gpt-4o", "gpt-4", "claude-3-5-sonnet", "auto"];
            let defaultModelId: string | undefined;
            for (const pref of PREFERRED_DEFAULTS) {
              if (discovered.some((m) => m.id === pref)) {
                defaultModelId = pref;
                break;
              }
            }
            if (!defaultModelId && discovered.length > 0) {
              defaultModelId = discovered[0].id;
            }
            const defaultModel = defaultModelId
              ? `${PROVIDER_ID}/${defaultModelId}`
              : AXONHUB_DEFAULT_MODEL_REF;

            // 4. Build auth result with a credential profile and a fresh
            //    catalog-shaped models[] (with `compat.supportedReasoningEfforts`
            //    derived from the family table). Writing the models array here
            //    is the migration path for users upgrading from <=1.0.7 whose
            //    stored axonhub.models[] was captured before family-table compat
            //    existed and therefore lacks the `compat` field — without this
            //    rewrite, OpenClaw's directive validator
            //    (buildConfiguredModelCatalog) only sees the base profile and
            //    rejects /think xhigh / /think max even though the runtime
            //    hook returns the right profile.
            const profileId = `${PROVIDER_ID}:default`;
            const credential = buildApiKeyCredential(
              PROVIDER_ID,
              capturedSecretInput ?? resolvedKey,
              undefined,
              capturedMode
                ? {
                    secretInputMode: capturedMode,
                    config: ctx.config,
                  }
                : undefined,
            );
            const refreshedModels = discovered.length > 0
              ? buildAxonhubCatalogModels(discovered)
              : undefined;
            const nextConfig = applyAxonhubConfig(
              ctx.config,
              baseUrl,
              refreshedModels,
            );

            return {
              profiles: [{ profileId, credential }],
              configPatch: nextConfig,
              defaultModel,
            };
          },
        },
      ],
      catalog: {
        order: "simple",
        run: async (ctx: ProviderCatalogContext) => {
          const { apiKey: authKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!authKey) {
            return null;
          }
          const instanceRoot = resolveAxonhubInstanceRoot(ctx.config);
          const { models: discovered } = await syncAxonhubModels({
            instanceRoot,
            apiKey: authKey,
            agentDir: ctx.agentDir,
          });

          const models = discovered.length > 0
            ? buildAxonhubCatalogModels(discovered)
            : [
                // Minimal fallback when AxonHub is unreachable
                {
                  id: "auto",
                  name: "AxonHub Auto",
                  reasoning: false,
                  input: ["text", "image"] as Array<"text" | "image">,
                  cost: { ...AXONHUB_DEFAULT_COST },
                  contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
                  maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
                },
              ];

          // Provider-level `api`/`baseUrl` remain the OpenAI-compatible default
          // so models without an explicit override (e.g. the "auto" fallback)
          // still resolve. Per-model `api`/`baseUrl` on the enriched rows route
          // Gemini/Anthropic/Responses/Chat to their own AxonHub endpoints.
          return {
            provider: {
              baseUrl: getAxonhubOpenAIEndpoint(instanceRoot),
              apiKey: authKey,
              api: "openai-completions",
              models,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicAxonhubModel(ctx),
      prepareDynamicModel: async (ctx: ProviderPrepareDynamicModelContext) => {
        // Async warm-up before the synchronous `resolveDynamicModel` retry:
        // resolve provider auth through the public runtime and warm the shared
        // discovery cache so `buildDynamicAxonhubModel` can read the enriched
        // record (correct protocol `api`/`baseUrl`) instead of the conservative
        // fallback.
        try {
          const instanceRoot = resolveAxonhubInstanceRoot(ctx.config);
          const auth = await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            cfg: ctx.config,
            agentDir: ctx.agentDir,
            workspaceDir: ctx.workspaceDir,
            profileId: ctx.authProfileId,
          });
          const apiKey = auth?.apiKey;
          if (!apiKey) {
            return;
          }
          await syncAxonhubModels({
            instanceRoot,
            apiKey,
            profileId: ctx.authProfileId,
            agentDir: ctx.agentDir,
          });
        } catch {
          // Warm-up is best-effort. On failure the synchronous resolver falls
          // back to a conservative metadata-derived model.
        }
      },
      resolveThinkingProfile: ({ modelId, reasoning }) =>
        buildAxonhubThinkingProfile(modelId, reasoning),
      supportsXHighThinking: ({ modelId }) => supportsAxonhubXHighThinking(modelId),
      wrapStreamFn: (ctx) => {
        const deepseekWrapped = createDeepSeekV4AxonhubThinkingWrapper({
          streamFn: ctx.streamFn,
          thinkingLevel: ctx.thinkingLevel,
        });
        return createOpenAICompatibleMaxThinkingWrapper({
          modelId: ctx.modelId,
          streamFn: deepseekWrapped ?? ctx.streamFn,
          thinkingLevel: ctx.thinkingLevel,
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      isModernModelRef: () => true,
      wizard: {
        setup: {
          choiceId: "axonhub-api-key",
          choiceLabel: "AxonHub",
          groupId: PROVIDER_ID,
          groupLabel: "AxonHub",
          groupHint: "API key from your AxonHub instance",
          methodId: "api-key",
        },
      },
    });

    // Register unified model catalog provider for live discovery (replaces
    // deprecated `augmentModelCatalog`). Provides supplemental text-model rows
    // when an API key is available.
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["text"],
      liveCatalog: async (ctx: UnifiedModelCatalogProviderContext) => {
        const envAuthKey = ctx.env?.[AXONHUB_API_KEY_ENV_VAR]?.trim();
        if (!envAuthKey) {
          return [];
        }
        const instanceRoot = resolveAxonhubInstanceRoot(ctx.config);
        const { models: discovered } = await syncAxonhubModels({
          instanceRoot,
          apiKey: envAuthKey,
          agentDir: ctx.agentDir,
          timeoutMs: ctx.timeoutMs,
        });
        if (discovered.length === 0) {
          return [];
        }
        const now = Date.now();
        return discovered.map((m): UnifiedModelCatalogEntry => ({
          kind: "text",
          provider: PROVIDER_ID,
          model: m.id,
          label: m.name,
          source: "live",
          fetchedAt: now,
        }));
      },
    });

    // Register the `openclaw axonhub models sync|status` CLI command group.
    // Nested under a top-level `axonhub` command via the public registerCli API.
    api.registerCli(
      (cliCtx) => {
        const axonhubCmd = cliCtx.program
          .command("axonhub")
          .description("AxonHub plugin commands");
        registerAxonhubCliCommands({ ...cliCtx, program: axonhubCmd });
      },
      {
        commands: ["axonhub"],
        descriptors: [
          {
            name: "axonhub",
            description: "AxonHub plugin commands",
            hasSubcommands: true,
          },
        ],
      },
    );

    // Register the plugin-only Codex runtime bridge. It only projects
    // `axonhub/<model>` selections that explicitly target the `codex` runtime;
    // ordinary AxonHub runs are untouched. The credential helper lives next to
    // this compiled module in `dist/`.
    const helperPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "codex-auth-helper.js",
    );
    registerCodexBridge(api, helperPath);
  },
});

export default axonhubPlugin;

// Re-export internals for backward-compat with consumers / tests that imported
// the old prefix-list-based helpers.
export {
  isAxonhubDeepSeekV4ModelId as isDeepSeekV4ModelId,
  normalizeAxonhubModelId,
  supportsAxonhubXHighThinking as supportsXHighThinkingModel,
};
