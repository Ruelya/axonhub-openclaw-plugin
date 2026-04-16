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
      envVars: ["AXONHUB_API_KEY"],
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
          expectedProviders: [PROVIDER_ID],
          applyConfig: applyAxonhubConfig,
          wizard: {
            choiceId: "axonhub-api-key",
            choiceLabel: "AxonHub API key",
            groupId: PROVIDER_ID,
            groupLabel: "AxonHub",
            groupHint: "API key from your AxonHub instance",
          },
        }),
        {
          id: "base-url",
          label: "AxonHub Base URL",
          kind: "api_key",
          run: async (ctx) => {
            const opts = ctx.opts as Record<string, unknown> | undefined;
            const baseUrl = (opts?.axonhubBaseUrl as string) || await ctx.prompter.prompt({
              message: "Enter your AxonHub instance URL",
              placeholder: AXONHUB_DEFAULT_BASE_URL,
              defaultValue: AXONHUB_DEFAULT_BASE_URL,
            });
            return {
              configPatch: {
                plugins: {
                  entries: {
                    axonhub: {
                      config: { baseUrl }
                    }
                  }
                }
              }
            };
          }
        }
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const opts = ctx.opts as Record<string, unknown> | undefined;
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey || (opts?.axonhubApiKey as string);
          if (!apiKey) {
            return null;
          }
          const baseUrl = (opts?.axonhubBaseUrl as string) || ctx.baseUrl || AXONHUB_DEFAULT_BASE_URL;
          return {
            provider: {
              ...buildAxonhubProvider(),
              baseUrl: `${baseUrl}${AXONHUB_API_PATH}`,
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
