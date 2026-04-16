import type { ModelProviderConfig, ModelCapability } from "openclaw/plugin-sdk/provider-model-shared";

const AXONHUB_API_PATH = "/v1";
const AXONHUB_DEFAULT_CONTEXT_WINDOW = 200000;
const AXONHUB_DEFAULT_MAX_TOKENS = 16384;
const AXONHUB_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildAxonhubProvider(): ModelProviderConfig {
  return {
    baseUrl: AXONHUB_API_PATH,
    api: "openai-completions",
    models: [
      {
        id: "axonhub/auto",
        name: "AxonHub Auto",
        reasoning: false,
        input: ["text", "image"],
        cost: AXONHUB_DEFAULT_COST,
        contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
      },
      {
        id: "axonhub/gpt-4o",
        name: "GPT-4o (via AxonHub)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.75 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
      {
        id: "axonhub/claude-3-5-sonnet",
        name: "Claude 3.5 Sonnet (via AxonHub)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "axonhub/gemini-2.0-flash",
        name: "Gemini 2.0 Flash (via AxonHub)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 8192,
      },
    ],
  };
}

export function resolveAxonhubModelCapabilities(
  modelId: string,
): ModelCapability | undefined {
  const provider = buildAxonhubProvider();
  const model = provider.models?.find((m) => m.id === modelId);
  
  if (model) {
    return {
      name: model.name,
      reasoning: model.reasoning ?? false,
      input: model.input ?? ["text"],
      cost: model.cost ?? AXONHUB_DEFAULT_COST,
      contextWindow: model.contextWindow ?? AXONHUB_DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? AXONHUB_DEFAULT_MAX_TOKENS,
    };
  }

  const prefix = "axonhub/";
  if (modelId.startsWith(prefix)) {
    const baseModelId = modelId.substring(prefix.length);
    return {
      name: `${baseModelId} (via AxonHub)`,
      reasoning: false,
      input: ["text"],
      cost: AXONHUB_DEFAULT_COST,
      contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
      maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
    };
  }

  return {
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: AXONHUB_DEFAULT_COST,
    contextWindow: AXONHUB_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AXONHUB_DEFAULT_MAX_TOKENS,
  };
}
