/**
 * CLI commands for AxonHub model synchronization and status.
 *
 * Registers `openclaw axonhub models sync` and `status` commands that force-refresh
 * the current agent/profile cache and report added, removed, and changed model ids.
 * Output is deterministic and secret-free.
 *
 * Design.md § 5: CLI synchronization surface.
 */

import type { OpenClawPluginCliContext } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { peekCachedModels, syncAxonhubModels } from "./model-sync.js";
import { normalizeAxonhubInstanceRoot } from "./url-helpers.js";
import { resolveAxonhubConfigBaseUrl, AXONHUB_DEFAULT_BASE_URL } from "./onboard.js";
import type { EnrichedModel } from "./model-types.js";

const PROVIDER_ID = "axonhub";

/**
 * Resolve the configured AxonHub instance root (no `/v1` suffix) from config,
 * falling back to the default instance.
 */
function resolveAxonhubInstanceRoot(config: OpenClawConfig | undefined): string {
  const configuredBaseUrl = resolveAxonhubConfigBaseUrl(config);
  const raw = configuredBaseUrl ?? AXONHUB_DEFAULT_BASE_URL;
  return normalizeAxonhubInstanceRoot(raw);
}

/**
 * Compute a deterministic diff between two sorted model sets. Returns the
 * added, removed, and changed models without exposing credentials or absolute
 * paths.
 */
function computeModelDiff(
  before: readonly EnrichedModel[],
  after: readonly EnrichedModel[],
): {
  added: EnrichedModel[];
  removed: EnrichedModel[];
  changed: Array<{ id: string; before: EnrichedModel; after: EnrichedModel }>;
} {
  const beforeMap = new Map(before.map((m) => [m.id, m]));
  const afterMap = new Map(after.map((m) => [m.id, m]));

  const added = after.filter((m) => !beforeMap.has(m.id));
  const removed = before.filter((m) => !afterMap.has(m.id));
  const changed: Array<{ id: string; before: EnrichedModel; after: EnrichedModel }> = [];

  for (const m of after) {
    const old = beforeMap.get(m.id);
    if (old && JSON.stringify(old) !== JSON.stringify(m)) {
      changed.push({ id: m.id, before: old, after: m });
    }
  }

  return { added, removed, changed };
}

/**
 * Register `openclaw axonhub models` command group with `sync` and `status`
 * subcommands.
 */
export function registerAxonhubCliCommands(ctx: OpenClawPluginCliContext): void {
  const { program, config, workspaceDir, logger } = ctx;

  const modelsCmd = program
    .command("models")
    .description("Manage AxonHub model cache");

  // openclaw axonhub models sync
  modelsCmd
    .command("sync")
    .description("Force-refresh the current agent/profile model cache")
    .option("--agent <path>", "Agent directory path")
    .option("--profile <id>", "Auth profile id")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option("--json", "Output JSON")
    .action(async (opts: { agent?: string; profile?: string; timeout?: string; json?: boolean }) => {
      try {
        const agentDir = opts.agent;
        const profileId = opts.profile;
        const timeoutMs = parseInt(opts.timeout ?? "10000", 10);

        const instanceRoot = resolveAxonhubInstanceRoot(config);

        // Resolve API key for the provider
        const auth = await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
          cfg: config,
          profileId,
          agentDir,
          workspaceDir,
        });

        if (!auth?.apiKey) {
          logger.error("No AxonHub API key found. Run `openclaw auth` to set up authentication.");
          process.exit(1);
        }

        // Peek the prior cached snapshot without triggering a fetch, so the
        // diff reflects what actually changed after the force-refresh.
        const before = await peekCachedModels({
          instanceRoot,
          apiKey: auth.apiKey,
          agentDir,
        });

        // Force-refresh to get the latest instance-visible set.
        const after = await syncAxonhubModels({
          instanceRoot,
          apiKey: auth.apiKey,
          profileId: auth.profileId ?? profileId,
          agentDir,
          timeoutMs,
          forceRefresh: true,
        });

        if (after.status.error && !after.status.stale) {
          logger.error(`Sync failed: ${after.status.error}`);
          process.exit(1);
        }

        const diff = computeModelDiff(before, after.models);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                instanceRoot,
                totalModels: after.models.length,
                added: diff.added.map((m) => m.id).sort(),
                removed: diff.removed.map((m) => m.id).sort(),
                changed: diff.changed.map((c) => c.id).sort(),
                fresh: after.status.fresh,
                stale: after.status.stale,
              },
              null,
              2,
            ),
          );
        } else {
          logger.info(`AxonHub instance: ${instanceRoot}`);
          logger.info(`Total models: ${after.models.length}`);

          if (diff.added.length > 0) {
            logger.info(`\nAdded (${diff.added.length}):`);
            diff.added.forEach((m) => logger.info(`  + ${m.id}`));
          }

          if (diff.removed.length > 0) {
            logger.info(`\nRemoved (${diff.removed.length}):`);
            diff.removed.forEach((m) => logger.info(`  - ${m.id}`));
          }

          if (diff.changed.length > 0) {
            logger.info(`\nChanged (${diff.changed.length}):`);
            diff.changed.forEach((c) => logger.info(`  ~ ${c.id}`));
          }

          if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
            logger.info("\nNo changes.");
          }

          if (after.status.stale) {
            logger.warn(`\n⚠ Warning: Sync partially failed, returned stale cache.`);
          }
        }
      } catch (err) {
        logger.error(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // openclaw axonhub models status
  modelsCmd
    .command("status")
    .description("Report model cache age, source URL, and freshness")
    .option("--agent <path>", "Agent directory path")
    .option("--profile <id>", "Auth profile id")
    .option("--json", "Output JSON")
    .action(async (opts: { agent?: string; profile?: string; json?: boolean }) => {
      try {
        const agentDir = opts.agent;
        const profileId = opts.profile;

        const instanceRoot = resolveAxonhubInstanceRoot(config);

        // Resolve API key for the provider
        const auth = await resolveApiKeyForProvider({
          provider: PROVIDER_ID,
          cfg: config,
          profileId,
          agentDir,
          workspaceDir,
        });

        if (!auth?.apiKey) {
          logger.error("No AxonHub API key found. Run `openclaw auth` to set up authentication.");
          process.exit(1);
        }

        // Read current cached state (no refresh)
        const result = await syncAxonhubModels({
          instanceRoot,
          apiKey: auth.apiKey,
          profileId: auth.profileId ?? profileId,
          agentDir,
          forceRefresh: false,
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                instanceRoot,
                modelCount: result.models.length,
                fresh: result.status.fresh,
                stale: result.status.stale,
                error: result.status.error,
              },
              null,
              2,
            ),
          );
        } else {
          logger.info(`AxonHub instance: ${instanceRoot}`);
          logger.info(`Model count: ${result.models.length}`);
          logger.info(`Status: ${result.status.fresh ? "fresh" : result.status.stale ? "stale" : "empty"}`);

          if (result.status.error) {
            logger.warn(`Error: ${result.status.error}`);
          }

          if (result.models.length === 0 && !result.status.error) {
            logger.info("\nNo cached models. Run `openclaw axonhub models sync` to fetch.");
          }
        }
      } catch (err) {
        logger.error(`Status error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
