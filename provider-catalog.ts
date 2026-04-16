import type { ModelCapability } from "openclaw/plugin-sdk/provider-model-shared";

const AXONHUB_DEFAULT_CONTEXT_WINDOW = 200000;
const AXONHUB_DEFAULT_MAX_TOKENS = 16384;
const AXONHUB_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function resolveAxonhubModelCapabilities(
  modelId: string,
): ModelCapability {
  const prefix = "axonhub/";
  if (modelId.startsWith(prefix)) {
    modelId = modelId.substring(prefix.length);
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
