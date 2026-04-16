import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-4o";
const AXONHUB_PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_API_PATH = "/v1";

export function applyAxonhubConfig(
  config: OpenClawConfig,
  baseUrl?: string,
): OpenClawConfig {
  let models = { ...config.models };
  let providers = { ...models.providers ?? {} };
  let axonhubProvider = { ...providers[AXONHUB_PROVIDER_ID] };

  axonhubProvider.defaultModel = AXONHUB_DEFAULT_MODEL_REF;

  const resolvedBaseUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}${AXONHUB_API_PATH}`
    : axonhubProvider.baseUrl ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
  axonhubProvider.baseUrl = resolvedBaseUrl;

  providers = { ...providers, [AXONHUB_PROVIDER_ID]: axonhubProvider };
  models = { ...models, providers };

  return { ...config, models };
}

export function resolveAxonhubConfigBaseUrl(config: OpenClawConfig): string | undefined {
  const provider = config.models?.providers?.[AXONHUB_PROVIDER_ID];
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  const baseUrl = (provider as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

export { AXONHUB_DEFAULT_BASE_URL, AXONHUB_API_PATH };
