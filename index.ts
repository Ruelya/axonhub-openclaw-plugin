import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderAugmentModelCatalogContext,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  normalizeApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAxonhubConfig,
  AXONHUB_DEFAULT_MODEL_REF,
  AXONHUB_DEFAULT_BASE_URL,
  AXONHUB_API_PATH,
  resolveAxonhubConfigBaseUrl,
  resolveAxonhubConfigApiKey,
} from "./onboard.js";

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

// --- AxonHub API types for /v1/models?include=... response ---

type AxonhubCapabilities = {
  vision?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
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
};

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
        };
      })
      .filter((m): m is DiscoveredModel => m !== null);
  } catch {
    return [];
  }
}

// --- Resolve API key from context (env + config, no credential store) ---

function resolveApiKeyForCatalog(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  // 1. Check environment variable
  const envKey = env?.[AXONHUB_API_KEY_ENV_VAR]?.trim();
  if (envKey) return envKey;

  // 2. Check config (stored during auth flow)
  return resolveAxonhubConfigApiKey(config);
}

// --- Plugin entry ---

export default definePluginEntry({
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
      const baseUrl = ctx.baseUrl ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
      return {
        id: ctx.modelId,
        name: ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { ...AXONHUB_DEFAULT_COST },
        contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
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

            // 2. Resolve API key: check env var first, then prompt
            const envApiKey = ctx.env?.[AXONHUB_API_KEY_ENV_VAR]?.trim();
            let apiKey: string;
            if (envApiKey) {
              const useEnv = await ctx.prompter.confirm({
                message: `Use existing ${AXONHUB_API_KEY_ENV_VAR} from environment?`,
                initialValue: true,
              });
              apiKey = useEnv
                ? envApiKey
                : ((await ctx.prompter.text({
                    message: "Enter your AxonHub API key",
                    placeholder: "ah-...",
                    validate: (value) => (value?.trim() ? undefined : "Required"),
                  }))?.trim() ?? "");
            } else {
              const apiKeyRaw = await ctx.prompter.text({
                message: "Enter your AxonHub API key",
                placeholder: "ah-...",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              });
              apiKey = normalizeApiKeyInput(apiKeyRaw?.trim() ?? "");
            }

            if (!apiKey) {
              throw new Error("Missing API key input for AxonHub.");
            }

            // 3. Try to discover models from the AxonHub instance
            const apiBaseUrl = `${baseUrl}${AXONHUB_API_PATH}`;
            const discovered = await fetchAxonhubModels({ baseUrl: apiBaseUrl, apiKey });

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

            // 4. Build auth result with config patch that includes apiKey
            const profileId = `${PROVIDER_ID}:default`;
            const credential = buildApiKeyCredential(PROVIDER_ID, apiKey);
            const nextConfig = applyAxonhubConfig(ctx.config, baseUrl, apiKey);

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
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const baseUrl = resolveAxonhubConfigBaseUrl(ctx.config)
            ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
          const discovered = await fetchAxonhubModels({ baseUrl, apiKey });

          const models = discovered.length > 0
            ? discovered.map((m) => ({
                id: m.id,
                name: m.name,
                reasoning: m.reasoning,
                input: m.input,
                cost: m.cost,
                contextWindow: m.contextWindow ?? AXONHUB_DEFAULT_CONTEXT_WINDOW,
                maxTokens: m.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
              }))
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
              apiKey,
              api: "openai-completions",
              models,
            },
          };
        },
      },
      augmentModelCatalog: async (ctx: ProviderAugmentModelCatalogContext) => {
        const baseUrl = resolveAxonhubConfigBaseUrl(ctx.config)
          ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
        const apiKey = resolveApiKeyForCatalog(ctx.config, ctx.env);

        if (apiKey) {
          const discovered = await fetchAxonhubModels({ baseUrl, apiKey });
          if (discovered.length > 0) {
            return discovered.map((m) => ({
              provider: PROVIDER_ID,
              id: m.id,
              name: m.name,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
              input: m.input,
            }));
          }
        }

        // No API key or unreachable: return empty so model picker doesn't
        // show stale hardcoded entries. The user can always type manually.
        return [];
      },
      resolveDynamicModel: (ctx) => buildDynamicAxonhubModel(ctx),
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
