import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderAugmentModelCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  normalizeApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildAxonhubProvider, resolveAxonhubModelCapabilities } from "./provider-catalog.js";
import {
  applyAxonhubConfig,
  AXONHUB_DEFAULT_MODEL_REF,
  AXONHUB_DEFAULT_BASE_URL,
  AXONHUB_API_PATH,
  resolveAxonhubConfigBaseUrl,
} from "./onboard.js";

const PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_MAX_TOKENS = 16384;
const AXONHUB_API_KEY_ENV_VAR = "AXONHUB_API_KEY";

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
      const capabilities = resolveAxonhubModelCapabilities(ctx.modelId);
      const baseUrl = ctx.baseUrl ?? AXONHUB_DEFAULT_BASE_URL;
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: `${baseUrl}${AXONHUB_API_PATH}`,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? ["text"],
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
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
            const env = ctx.env ?? process.env;
            const envApiKey = env[AXONHUB_API_KEY_ENV_VAR]?.trim();
            let apiKey: string;
            if (envApiKey) {
              const useEnv = await ctx.prompter.confirm({
                message: `Use existing ${AXONHUB_API_KEY_ENV_VAR} from environment?`,
                initialValue: true,
              });
              apiKey = useEnv ? envApiKey : (await ctx.prompter.text({
                message: "Enter your AxonHub API key",
                placeholder: "sk-...",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              }))?.trim() ?? "";
            } else {
              const apiKeyRaw = await ctx.prompter.text({
                message: "Enter your AxonHub API key",
                placeholder: "sk-...",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              });
              apiKey = normalizeApiKeyInput(apiKeyRaw?.trim() ?? "");
            }

            if (!apiKey) {
              throw new Error("Missing API key input for AxonHub.");
            }

            // 3. Build result
            const profileId = `${PROVIDER_ID}:default`;
            const credential = buildApiKeyCredential(PROVIDER_ID, apiKey);
            const nextConfig = applyAxonhubConfig(ctx.config, baseUrl);

            return {
              profiles: [{ profileId, credential }],
              configPatch: nextConfig,
              defaultModel: AXONHUB_DEFAULT_MODEL_REF,
            };
          },
        },
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const configuredBaseUrl = resolveAxonhubConfigBaseUrl(ctx.config);
          const baseUrl = configuredBaseUrl ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
          return {
            provider: {
              ...buildAxonhubProvider(),
              baseUrl,
              apiKey,
            },
          };
        },
      },
      augmentModelCatalog: (_ctx: ProviderAugmentModelCatalogContext) => {
        const provider = buildAxonhubProvider();
        return (provider.models ?? []).map((model) => ({
          provider: PROVIDER_ID,
          id: model.id,
          name: model.name ?? model.id,
          contextWindow: model.contextWindow,
          reasoning: model.reasoning,
          input: model.input,
        }));
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
