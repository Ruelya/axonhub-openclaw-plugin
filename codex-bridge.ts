/**
 * Codex runtime bridge orchestration.
 *
 * Registers the `before_model_resolve` hook that projects `axonhub/<model>`
 * selections explicitly targeting the `codex` runtime into a managed custom
 * Codex provider. This allows AxonHub-backed models to run through the Codex
 * harness without requiring an OpenClaw core patch.
 *
 * Design.md § Codex Runtime Bridge, subsection 5: Session behavior, plus
 * overall wiring.
 */

import type {
  OpenClawPluginApi,
  OpenClawConfig,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeAxonhubInstanceRoot } from "./url-helpers.js";
import { resolveAxonhubConfigBaseUrl, AXONHUB_DEFAULT_BASE_URL } from "./onboard.js";
import { isCodexRuntimeIntended } from "./codex-runtime.js";
import { deriveCodexProviderId } from "./codex-provider-id.js";
import {
  resolveCodexHome,
  codexConfigPath,
  writeCodexAuthWrapper,
} from "./codex-home.js";
import { reconcileCodexProviderBlock } from "./codex-toml.js";

const PROVIDER_ID = "axonhub";

/**
 * Kill-switch env var. When set to a truthy value ("1", "true", "yes"), the
 * Codex bridge no-ops entirely and ordinary AxonHub behavior is preserved.
 * This is an emergency escape hatch that never changes normal provider routing.
 */
const BRIDGE_DISABLE_ENV = "AXONHUB_CODEX_BRIDGE_DISABLED";

/** Whether the bridge kill-switch is engaged via env. */
function isBridgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BRIDGE_DISABLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Resolve the configured AxonHub instance root (no `/v1` suffix) from config,
 * falling back to the default instance. Reuses onboard helpers so the routing
 * root cannot drift from the rest of the plugin.
 */
function resolveAxonhubInstanceRoot(config: OpenClawConfig | undefined): string {
  const configuredBaseUrl = resolveAxonhubConfigBaseUrl(config);
  const raw = configuredBaseUrl ?? AXONHUB_DEFAULT_BASE_URL;
  return normalizeAxonhubInstanceRoot(raw);
}

/**
 * Handle the `before_model_resolve` hook for AxonHub Codex projection.
 *
 * When the original provider is `axonhub` and the effective runtime is
 * explicitly `codex`, reconcile the managed Codex provider and return a
 * projection override. Otherwise, return void (fall through to normal AxonHub
 * behavior).
 *
 * Exported for integration testing. On any bridge error it logs a warning and
 * returns void so ordinary AxonHub runs are never broken.
 */
export async function handleBeforeModelResolve(
  _event: PluginHookBeforeModelResolveEvent,
  ctx: PluginHookAgentContext,
  configInput: OpenClawConfig | undefined,
  helperPath: string,
): Promise<PluginHookBeforeModelResolveResult | void> {
  // Emergency kill-switch: never touch routing when disabled.
  if (isBridgeDisabled()) {
    return;
  }

  // Only act when the original provider is axonhub.
  if (ctx.modelProviderId !== PROVIDER_ID) {
    return;
  }

  const modelId = ctx.modelId;
  if (!modelId) {
    return;
  }

  // Resolve the effective config. Tests inject one directly; at runtime the
  // public runtime-config snapshot is loaded lazily per invocation so the hook
  // reflects the current config without capturing a stale one at registration.
  let config = configInput;
  if (!config) {
    try {
      config = getRuntimeConfig();
    } catch {
      // Without a resolvable config we cannot derive runtime intent or a stable
      // agent-scoped home; fall through to normal AxonHub behavior.
      return;
    }
  }

  // Check whether the effective runtime is explicitly codex. When it is not
  // (auto/default/openclaw/missing), fall through to normal AxonHub behavior.
  //
  // sessionRuntimeOverride is not exposed in the public hook context, so the
  // plugin relies on config-based runtime selection (agent/provider/model
  // agentRuntime.id) as the primary mechanism for opting into Codex.
  const intendedCodex = isCodexRuntimeIntended({
    config,
    agentId: ctx.agentId,
    modelId,
    sessionRuntimeOverride: undefined,
  });

  if (!intendedCodex) {
    return;
  }

  try {
    // Resolve the agent directory using OpenClaw's public agent-runtime helper.
    // resolveAgentDir requires a config; without one we cannot derive a stable
    // agent-scoped home, so fall through to normal behavior.
    const agentDir =
      config && ctx.agentId ? resolveAgentDir(config, ctx.agentId) : undefined;

    // Session-level auth profile override is not exposed in the public hook
    // context, so the plugin uses the default profile. When a user explicitly
    // selects a non-default profile for an AxonHub-Codex run, they must also
    // set the profile at the agent/provider/model config level for the plugin
    // to derive the correct provider id.
    const profileId = undefined;

    const providerId = deriveCodexProviderId(agentDir, profileId);

    // Resolve the effective Codex home and reconcile the managed provider block.
    const codexHome = resolveCodexHome(agentDir);
    const instanceRoot = resolveAxonhubInstanceRoot(config);

    // Generate the per-agent auth wrapper. The wrapper embeds the agent
    // directory and profile so the packaged helper resolves the correct
    // credential even when multiple agents share a user Codex home.
    const wrapperPath = writeCodexAuthWrapper(codexHome, {
      providerId,
      helperPath,
      agentDir: agentDir ?? process.cwd(),
      profileId,
    });

    // Reconcile the managed TOML block. Fails closed on an unmarked collision.
    await reconcileCodexProviderBlock(codexConfigPath(codexHome), {
      providerId,
      instanceRoot,
      wrapperPath,
    });

    // Project: provider=codex, model=<providerId>/<originalModelId>. The Codex
    // provider resolves the qualified id dynamically; app-server splits it into
    // modelProvider=providerId and model=originalModelId.
    return {
      providerOverride: "codex",
      modelOverride: `${providerId}/${modelId}`,
    };
  } catch (err) {
    // On any bridge error, log a warning and fall through to normal AxonHub
    // behavior so the plugin never breaks ordinary runs.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[axonhub-openclaw-plugin] Codex bridge skipped (falling back to normal AxonHub): ${message}`,
    );
    return;
  }
}

/**
 * Register the Codex runtime bridge hook.
 *
 * The handler resolves the effective OpenClaw config lazily per invocation via
 * the public runtime-config snapshot, so no config needs to be captured at
 * registration time (which would risk staleness).
 *
 * @param api - OpenClaw plugin API.
 * @param helperPath - Absolute path to the packaged credential helper.
 */
export function registerCodexBridge(
  api: OpenClawPluginApi,
  helperPath: string,
): void {
  api.on(
    "before_model_resolve",
    (event, ctx) => handleBeforeModelResolve(event, ctx, undefined, helperPath),
    {
      priority: 100,
    },
  );
}
