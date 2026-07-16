import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export const AXONHUB_DEFAULT_MODEL_REF = "axonhub/gpt-4o";
const AXONHUB_PROVIDER_ID = "axonhub";
const AXONHUB_DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_API_PATH = "/v1";
const AXONHUB_PROVIDER_API_KIND = "openai-completions";

/**
 * Strip a trailing `/v1` so plugin config stores the instance root (matches
 * `plugins.entries.axonhub.config.baseUrl` schema default).
 */
function toInstanceRoot(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

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
 * Also enables `plugins.entries.axonhub.hooks.allowConversationAccess` so the
 * non-bundled Codex bridge (`before_model_resolve`) is allowed by OpenClaw's
 * conversation-hook policy for third-party plugins.
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
  models?: ReadonlyArray<unknown>,
): OpenClawConfig {
  let modelsRoot = { ...config.models };
  let providers = { ...modelsRoot.providers ?? {} };
  let axonhubProvider = { ...providers[AXONHUB_PROVIDER_ID] };

  const resolvedBaseUrl = baseUrl
    ? `${toInstanceRoot(baseUrl)}${AXONHUB_API_PATH}`
    : axonhubProvider.baseUrl ?? `${AXONHUB_DEFAULT_BASE_URL}${AXONHUB_API_PATH}`;
  axonhubProvider.baseUrl = resolvedBaseUrl;

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

  // Plugin entry: enable + allow conversation hooks + store instance root.
  // OpenClaw blocks non-bundled `before_model_resolve` (Codex bridge) unless
  // `hooks.allowConversationAccess` is true.
  const instanceRoot = toInstanceRoot(
    typeof baseUrl === "string" && baseUrl.trim()
      ? baseUrl
      : typeof axonhubProvider.baseUrl === "string"
        ? axonhubProvider.baseUrl
        : AXONHUB_DEFAULT_BASE_URL,
  );
  const pluginsRoot = { ...(config.plugins ?? {}) } as Record<string, unknown>;
  const entries = {
    ...((pluginsRoot.entries as Record<string, unknown> | undefined) ?? {}),
  };
  const existingEntry =
    entries[AXONHUB_PROVIDER_ID] &&
    typeof entries[AXONHUB_PROVIDER_ID] === "object"
      ? (entries[AXONHUB_PROVIDER_ID] as Record<string, unknown>)
      : {};
  const existingHooks =
    existingEntry.hooks && typeof existingEntry.hooks === "object"
      ? (existingEntry.hooks as Record<string, unknown>)
      : {};
  const existingPluginConfig =
    existingEntry.config && typeof existingEntry.config === "object"
      ? (existingEntry.config as Record<string, unknown>)
      : {};

  entries[AXONHUB_PROVIDER_ID] = {
    ...existingEntry,
    enabled: true,
    hooks: {
      ...existingHooks,
      allowConversationAccess: true,
    },
    config: {
      ...existingPluginConfig,
      baseUrl: instanceRoot,
    },
  };
  pluginsRoot.entries = entries;

  // Keep axonhub on the allowlist when the host uses an explicit allow list.
  const allow = pluginsRoot.allow;
  if (Array.isArray(allow)) {
    const nextAllow = allow.filter((id): id is string => typeof id === "string");
    if (!nextAllow.includes(AXONHUB_PROVIDER_ID)) {
      pluginsRoot.allow = [...nextAllow, AXONHUB_PROVIDER_ID];
    }
  }

  return {
    ...config,
    models: modelsRoot,
    plugins: pluginsRoot as OpenClawConfig["plugins"],
  };
}

export function resolveAxonhubConfigBaseUrl(config: OpenClawConfig | undefined): string | undefined {
  if (!config) return undefined;
  const provider = config.models?.providers?.[AXONHUB_PROVIDER_ID];
  if (!provider || typeof provider !== "object") return undefined;
  const baseUrl = (provider as Record<string, unknown>).baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

export { AXONHUB_DEFAULT_BASE_URL, AXONHUB_API_PATH };
