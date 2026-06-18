import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderAugmentModelCatalogContext,
  type ProviderCatalogContext,
  type ProviderThinkingProfile,
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
  readApiReasoningEfforts,
  resolveAxonhubFamily,
  supportsAxonhubMaxThinking,
  supportsAxonhubXHighThinking,
} from "./family-table.js";

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

// --- AxonHub API types for /v1/models?include=... response ---

type AxonhubCapabilities = {
  vision?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  // Forward-compat: AxonHub v0.9.38 doesn't expose any of these, but if a
  // future version adds them, the plugin reads them via readApiReasoningEfforts.
  reasoning_efforts?: string[];
  reasoning_effort_levels?: string[];
  effort_levels?: string[];
  reasoning_levels?: string[];
};

type AxonhubPricing = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  unit?: string;
  currency?: string;
};

type AxonhubModelEntry = {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  description?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: AxonhubCapabilities;
  pricing?: AxonhubPricing;
  type?: string;
  icon?: string;
};

type AxonhubModelsResponse = {
  object?: string;
  data?: AxonhubModelEntry[];
};

// --- Model types ---

type DiscoveredModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  vision: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /**
   * Per-model `compat.supportedReasoningEfforts` to surface in the catalog.
   * Computed from the API response (forward-compat) or the family table.
   * Undefined when neither source has an opinion (lets OpenClaw transport
   * auto-detect via id pattern + auto-downgrade).
   */
  supportedReasoningEfforts?: readonly string[];
};

/**
 * Resolve the per-model compat efforts list for a discovered model.
 *
 * Priority:
 * 1. AxonHub API-provided list (forward-compat for unreleased fields).
 * 2. Family-table override for non-OpenAI families that need to bypass
 *    OpenClaw's built-in OpenAI-only registry default.
 * 3. Undefined → let OpenClaw transport handle it.
 */
function resolveSupportedReasoningEfforts(
  modelId: string,
  apiEntry: AxonhubModelEntry,
): readonly string[] | undefined {
  const fromApi = readApiReasoningEfforts(apiEntry);
  if (fromApi) {
    return fromApi;
  }
  const family = resolveAxonhubFamily(modelId);
  return family?.supportedEffortsForCompat;
}

// --- AxonHub API fetch ---

async function fetchAxonhubModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
  const baseUrl = params.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/models?include=name,capabilities,context_length,max_output_tokens,pricing,type`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as AxonhubModelsResponse;
    const models = Array.isArray(data.data) ? data.data : [];
    return models
      .map((m): DiscoveredModel | null => {
        const id = typeof m.id === "string" ? m.id.trim() : "";
        if (!id) return null;
        // Only include chat-type models
        if (m.type && m.type !== "chat") return null;

        const hasVision = m.capabilities?.vision === true;
        return {
          id,
          name: m.name?.trim() || id,
          contextWindow:
            typeof m.context_length === "number" && m.context_length > 0
              ? m.context_length
              : undefined,
          maxTokens:
            typeof m.max_output_tokens === "number" && m.max_output_tokens > 0
              ? m.max_output_tokens
              : undefined,
          reasoning: m.capabilities?.reasoning === true,
          vision: hasVision,
          input: hasVision ? ["text", "image"] : ["text"],
          cost: {
            input: m.pricing?.input ?? 0,
            output: m.pricing?.output ?? 0,
            cacheRead: m.pricing?.cache_read ?? 0,
            cacheWrite: m.pricing?.cache_write ?? 0,
          },
          supportedReasoningEfforts: resolveSupportedReasoningEfforts(id, m),
        };
      })
      .filter((m): m is DiscoveredModel => m !== null);
  } catch {
    return [];
  }
}

/**
 * Build the optional `compat` block for a discovered model. Only includes
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
 * Shape a discovered AxonHub model into the catalog-entry object that both
 * `catalog.run` and `augmentModelCatalog` return. Centralized so the migration
 * path in `auth.run` (which writes the same shape into stored config via
 * `applyAxonhubConfig`) cannot drift. Return type is inferred so it stays
 * structurally compatible with both `ModelDefinitionConfig` (catalog/cfg) and
 * `ModelCatalogEntry` (augment, which subsets these fields).
 */
function buildAxonhubCatalogModelEntry(m: DiscoveredModel) {
  const compat = buildCatalogCompat(m);
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow ?? AXONHUB_DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
    ...(compat ? { compat } : {}),
  };
}

function buildAxonhubCatalogModels(discovered: DiscoveredModel[]) {
  return discovered.map(buildAxonhubCatalogModelEntry);
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

    function buildDynamicAxonhubModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const configuredBaseUrl = resolveAxonhubConfigBaseUrl(ctx.config);
      const baseUrl = ctx.providerConfig?.baseUrl
        ?? (configuredBaseUrl ? configuredBaseUrl.replace(/\/+$/, "") : undefined)
        ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
      const family = resolveAxonhubFamily(ctx.modelId);
      const dynamicCompat = family?.supportedEffortsForCompat?.length
        ? { supportedReasoningEfforts: [...family.supportedEffortsForCompat] }
        : undefined;
      return {
        id: ctx.modelId,
        name: ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl,
        reasoning: family !== null,
        input: ["text"],
        cost: { ...AXONHUB_DEFAULT_COST },
        contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
        ...(dynamicCompat ? { compat: dynamicCompat } : {}),
      };
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

            // 3. Try to discover models from the AxonHub instance
            const apiBaseUrl = `${baseUrl}${AXONHUB_API_PATH}`;
            const discovered = await fetchAxonhubModels({ baseUrl: apiBaseUrl, apiKey: resolvedKey });

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
          const configuredBaseUrl = resolveAxonhubConfigBaseUrl(ctx.config);
          const baseUrl = configuredBaseUrl
            ? configuredBaseUrl.replace(/\/+$/, "")
            : `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
          const discovered = await fetchAxonhubModels({ baseUrl, apiKey: authKey });

          const models = discovered.length > 0
            ? discovered.map(buildAxonhubCatalogModelEntry)
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

          return {
            provider: {
              baseUrl,
              apiKey: authKey,
              api: "openai-completions",
              models,
            },
          };
        },
      },
      augmentModelCatalog: async (ctx: ProviderAugmentModelCatalogContext) => {
        const configuredBaseUrl = resolveAxonhubConfigBaseUrl(ctx.config);
        const baseUrl = configuredBaseUrl
          ? configuredBaseUrl.replace(/\/+$/, "")
          : `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
        const envAuthKey = ctx.env?.[AXONHUB_API_KEY_ENV_VAR]?.trim();

        if (envAuthKey) {
          const discovered = await fetchAxonhubModels({ baseUrl, apiKey: envAuthKey });
          if (discovered.length > 0) {
            return discovered.map((m) => ({
              provider: PROVIDER_ID,
              ...buildAxonhubCatalogModelEntry(m),
            }));
          }
        }

        // No API key or unreachable: return empty so model picker doesn't
        // show stale hardcoded entries. The user can always type manually.
        return [];
      },
      resolveDynamicModel: (ctx) => buildDynamicAxonhubModel(ctx),
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
