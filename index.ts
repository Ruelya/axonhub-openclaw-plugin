import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildAxonhubProvider, resolveAxonhubModelCapabilities } from "./provider-catalog.js";
import { applyAxonhubConfig, AXONHUB_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_API_PATH = "/v1";
const AXONHUB_DEFAULT_MAX_TOKENS = 16384;

export default definePluginEntry({
  id: "axonhub",
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
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: `${ctx.baseUrl ?? AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`,
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
      envVars: ["AXONHUB_API_KEY", "AXONHUB_BASE_URL"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "AxonHub API key",
          hint: "API key from your AxonHub instance",
          optionKey: "axonhubApiKey",
          flagName: "--axonhub-api-key",
          envVar: "AXONHUB_API_KEY",
          promptMessage: "Enter your AxonHub API key",
          defaultModel: AXONHUB_DEFAULT_MODEL_REF,
          expectedProviders: ["axonhub"],
          applyConfig: (cfg) => applyAxonhubConfig(cfg),
          wizard: {
            choiceId: "axonhub-api-key",
            choiceLabel: "AxonHub API key",
            groupId: "axonhub",
            groupLabel: "AxonHub",
            groupHint: "API key from your AxonHub instance",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKeyResult = ctx.resolveProviderApiKey(PROVIDER_ID);
          const apiKey = apiKeyResult.apiKey;
          if (!apiKey) {
            return null;
          }
          const baseUrl = ctx.baseUrl ?? AXONHUB_DEFAULT_BASE_URL;
          return {
            provider: {
              ...buildAxonhubProvider(baseUrl),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicAxonhubModel(ctx),
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      isModernModelRef: () => true,
    });
  },
});