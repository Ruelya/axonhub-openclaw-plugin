import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-4o";
const AXONHUB_PROVIDER_ID = "axonhub";

export function applyAxonhubConfig(config: OpenClawConfig): OpenClawConfig {
  let models = { ...config.models };
  let providers = { ...models.providers ?? {} };
  let axonhubProvider = { ...providers[AXONHUB_PROVIDER_ID] };

  axonhubProvider.defaultModel = AXONHUB_DEFAULT_MODEL_REF;

  providers = { ...providers, [AXONHUB_PROVIDER_ID]: axonhubProvider };
  models = { ...models, providers };
  
  return { ...config, models };
}