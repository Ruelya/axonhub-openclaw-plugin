import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-4o";
const AXONHUB_PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_API_PATH = "/v1";
const AXONHUB_PROVIDER_API_KIND = "openai-completions";

/**
 * Apply AxonHub config patch.
 *
 * When `models` is provided, the stored `models.providers.axonhub.models` array
 * is fully replaced with the supplied list. This is the migration path for
 * upgrading users — fresh entries carry `compat.supportedReasoningEfforts`
 * built from the family table, so OpenClaw's directive validator
 * (`buildConfiguredModelCatalog` → `formatThinkingLevels` →
 * `isThinkingLevelSupported`) sees xhigh/max as supported levels. Without this
 * write, the static cfg pre-dates the family-table compat work and only the
 * base profile (off..high) is offered at the `/think` command site, even
 * though the runtime hook returns the right profile.
 *
 * `models` is typed loosely (`unknown[]`) because callers in index.ts produce
 * the catalog-entry shape from `buildAxonhubCatalogModelEntry`, which already
 * matches `ModelDefinitionConfig` structurally. Importing the SDK's
 * `ModelDefinitionConfig` type here would couple onboard.ts to internal SDK
 * paths that are not part of the public package exports.
 */
export function applyAxonhubConfig(
  config: OpenClawConfig,
  baseUrl?: string,
  apiKey?: string,
  models?: ReadonlyArray<unknown>,
): OpenClawConfig {
  let modelsRoot = { ...config.models };
  let providers = { ...modelsRoot.providers ?? {} };
  let axonhubProvider = { ...providers[AXONHUB_PROVIDER_ID] };

  const resolvedBaseUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}${AXONHUB_API_PATH}`
    : axonhubProvider.baseUrl ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
  axonhubProvider.baseUrl = resolvedBaseUrl;

  if (apiKey) {
    axonhubProvider.apiKey = apiKey;
  }

  if (models) {
    // Cast through unknown because the SDK's ModelDefinitionConfig type is not
    // exposed via package exports; the structural shape is enforced at the
    // call sites in index.ts.
    axonhubProvider.models = models.map((m) => ({ ...(m as object) })) as typeof axonhubProvider.models;
    if (typeof axonhubProvider.api !== "string") {
      axonhubProvider.api = AXONHUB_PROVIDER_API_KIND;
    }
  }

  providers = { ...providers, [AXONHUB_PROVIDER_ID]: axonhubProvider };
  modelsRoot = { ...modelsRoot, providers };

  return { ...config, models: modelsRoot };
}

export function resolveAxonhubConfigBaseUrl(config: OpenClawConfig | undefined): string | undefined {
  if (!config) return undefined;
  const provider = config.models?.providers?.[AXONHUB_PROVIDER_ID];
  if (!provider || typeof provider !== "object") return undefined;
  const baseUrl = (provider as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

export function resolveAxonhubConfigApiKey(config: OpenClawConfig | undefined): string | undefined {
  if (!config) return undefined;
  const provider = config.models?.providers?.[AXONHUB_PROVIDER_ID];
  if (!provider || typeof provider !== "object") return undefined;
  const apiKey = (provider as Record<string, unknown>).apiKey;
  return typeof apiKey === "string" ? apiKey : undefined;
}

export { AXONHUB_DEFAULT_BASE_URL, AXONHUB_API_PATH };
