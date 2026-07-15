/**
 * Codex runtime detection and projection logic.
 *
 * Determines whether an AxonHub model selection is explicitly targeting the
 * Codex runtime. When it is, the plugin projects the provider/model identity
 * to a custom Codex provider so the Codex harness can accept and route the
 * request.
 *
 * Design.md § Codex Runtime Bridge, subsection 1: Detecting intended Codex runtime.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Agent runtime policy config shape extracted from OpenClaw's config types.
 * Mirrors `AgentRuntimePolicyConfig` without importing private source.
 */
type AgentRuntimePolicy = {
  id?: string;
};

/**
 * Resolve the effective agent runtime id for an AxonHub model selection.
 *
 * Mirrors OpenClaw's documented precedence for this provider:
 * 1. session `agentRuntimeOverride` (passed as param when available from public session state)
 * 2. agent exact model entry
 * 3. provider model entry
 * 4. agent provider-wildcard entry
 * 5. provider `agentRuntime`
 *
 * Returns the runtime id when explicitly set, or undefined when auto/default/missing.
 *
 * @param opts.config - Current OpenClaw config
 * @param opts.agentId - Current agent id (for agent-specific model/runtime)
 * @param opts.modelId - AxonHub model id (without provider prefix)
 * @param opts.sessionRuntimeOverride - Session-level runtime override when available
 * @returns Explicit runtime id, or undefined when not set/auto/default
 */
export function resolveEffectiveRuntime(opts: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  modelId: string;
  sessionRuntimeOverride?: string;
}): string | undefined {
  const { config, agentId, modelId, sessionRuntimeOverride } = opts;

  // 1. Session runtime override (highest priority)
  if (sessionRuntimeOverride) {
    return normalizeRuntimeId(sessionRuntimeOverride);
  }

  if (!config) {
    return undefined;
  }

  const providerId = "axonhub";

  // 2. Agent exact model entry: agents.<agentId>.models["axonhub/<modelId>"].agentRuntime.id
  if (agentId && config.agents?.list) {
    const agent = config.agents.list.find((a) => a.id === agentId);
    if (agent?.models) {
      const exactKey = `${providerId}/${modelId}`;
      const exactEntry = agent.models[exactKey];
      if (exactEntry?.agentRuntime?.id) {
        return normalizeRuntimeId(exactEntry.agentRuntime.id);
      }
    }
  }

  // 3. Provider model entry: models.providers.axonhub.models[].agentRuntime.id
  const providerModels = config.models?.providers?.[providerId]?.models;
  if (providerModels && Array.isArray(providerModels)) {
    const providerModelEntry = providerModels.find((m) => m.id === modelId);
    if (providerModelEntry?.agentRuntime?.id) {
      return normalizeRuntimeId(providerModelEntry.agentRuntime.id);
    }
  }

  // 4. Agent provider-wildcard entry: agents.<agentId>.models["axonhub/*"].agentRuntime.id
  if (agentId && config.agents?.list) {
    const agent = config.agents.list.find((a) => a.id === agentId);
    if (agent?.models) {
      const wildcardKey = `${providerId}/*`;
      const wildcardEntry = agent.models[wildcardKey];
      if (wildcardEntry?.agentRuntime?.id) {
        return normalizeRuntimeId(wildcardEntry.agentRuntime.id);
      }
    }
  }

  // 5. Provider-level agentRuntime: models.providers.axonhub.agentRuntime.id
  const providerRuntime = config.models?.providers?.[providerId]?.agentRuntime as
    | AgentRuntimePolicy
    | undefined;
  if (providerRuntime?.id) {
    return normalizeRuntimeId(providerRuntime.id);
  }

  return undefined;
}

/**
 * Normalize a runtime id. `auto`, `default`, `openclaw`, and empty values
 * do not represent an explicit runtime selection and return undefined.
 * Only concrete runtime ids like `codex` trigger projection.
 */
function normalizeRuntimeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const normalized = id.trim().toLowerCase();
  if (normalized === "auto" || normalized === "default" || normalized === "openclaw" || normalized === "") {
    return undefined;
  }
  return normalized;
}

/**
 * Check whether an AxonHub model selection is explicitly targeting the Codex runtime.
 *
 * @returns true if the effective runtime is exactly "codex", false otherwise
 */
export function isCodexRuntimeIntended(opts: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  modelId: string;
  sessionRuntimeOverride?: string;
}): boolean {
  const runtime = resolveEffectiveRuntime(opts);
  return runtime === "codex";
}
