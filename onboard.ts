import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-4o";
const AXONHUB_PROVIDER_ID = "axonhub";

export function applyAxonhubConfig(config: OpenClawConfig): OpenClawConfig {
  const next = { ...config };
  
  if (!next.agents) next.agents = {};
  if (!next.agents.defaults) next.agents.defaults = {};
  
  // Set global default model if not set
  if (!next.agents.defaults.model) {
    next.agents.defaults.model = { primary: AXONHUB_DEFAULT_MODEL_REF };
  }

  // Ensure axonhub provider config exists
  if (!next.models) next.models = {};
  if (!next.models.providers) next.models.providers = {};
  if (!next.models.providers[AXONHUB_PROVIDER_ID]) {
    next.models.providers[AXONHUB_PROVIDER_ID] = {};
  }
  
  // Set provider-specific default model
  next.models.providers[AXONHUB_PROVIDER_ID].defaultModel = AXONHUB_DEFAULT_MODEL_REF;

  return next;
}
