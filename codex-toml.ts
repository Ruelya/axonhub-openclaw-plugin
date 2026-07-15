/**
 * Managed Codex `config.toml` provider-block reconciliation.
 *
 * The plugin owns a single marked TOML block per Codex provider id inside the
 * effective Codex home's `config.toml`. It performs text-level managed-block
 * replacement so unrelated user TOML (comments, formatting, other providers)
 * is never touched.
 *
 * Design.md § Codex Runtime Bridge, subsection 3: Managed Codex provider block.
 *
 * Guarantees:
 * - detects an unmarked `[model_providers.<id>]` table collision and fails closed;
 * - serializes concurrent writes with a bounded in-process lock;
 * - writes a temp file, renames atomically, and enforces `0600`;
 * - removes only its own marked block during explicit cleanup.
 */

import fs from "node:fs";
import path from "node:path";

const MARKER_PREFIX = "axonhub-openclaw-plugin";

/** Begin marker for a managed block. */
export function beginMarker(providerId: string): string {
  return `# >>> ${MARKER_PREFIX}:${providerId}`;
}

/** End marker for a managed block. */
export function endMarker(providerId: string): string {
  return `# <<< ${MARKER_PREFIX}:${providerId}`;
}

/** Options for reconciling a managed Codex provider block. */
export type CodexProviderBlockOptions = {
  /** Codex provider id (e.g. `axonhub_openclaw_7f3a91c2d8ab`). */
  providerId: string;
  /** Normalized AxonHub instance root (no `/v1` suffix). */
  instanceRoot: string;
  /** Absolute path to the agent-specific auth wrapper executable. */
  wrapperPath: string;
  /** Display name for the provider block. Defaults to "AxonHub via OpenClaw". */
  name?: string;
  /** Auth command timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
  /** Auth refresh interval in ms. Defaults to 300000. */
  refreshIntervalMs?: number;
};

/**
 * Build the managed TOML block text for a Codex provider.
 * The block routes through AxonHub's OpenAI Responses endpoint (`<root>/v1`)
 * and uses a command-auth helper that prints a bearer token to stdout.
 */
export function buildManagedBlock(opts: CodexProviderBlockOptions): string {
  const {
    providerId,
    instanceRoot,
    wrapperPath,
    name = "AxonHub via OpenClaw",
    timeoutMs = 5000,
    refreshIntervalMs = 300000,
  } = opts;
  const baseUrl = `${instanceRoot.replace(/\/+$/, "")}/v1`;
  const lines = [
    beginMarker(providerId),
    `[model_providers.${providerId}]`,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = "responses"`,
    ``,
    `[model_providers.${providerId}.auth]`,
    `command = ${tomlString(wrapperPath)}`,
    `timeout_ms = ${timeoutMs}`,
    `refresh_interval_ms = ${refreshIntervalMs}`,
    endMarker(providerId),
  ];
  return lines.join("\n");
}

/** Serialize a string as a basic TOML string literal. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Locate the managed-block span for a provider id inside TOML text.
 * Returns the `[start, end)` character offsets covering the whole marked block
 * including markers, or null when absent.
 */
function findManagedBlock(
  content: string,
  providerId: string,
): { start: number; end: number } | null {
  const begin = beginMarker(providerId);
  const end = endMarker(providerId);
  const startIdx = content.indexOf(begin);
  if (startIdx === -1) {
    return null;
  }
  const endMarkerIdx = content.indexOf(end, startIdx);
  if (endMarkerIdx === -1) {
    return null;
  }
  // Extend the end offset to the end of the end-marker line.
  let endLineEnd = content.indexOf("\n", endMarkerIdx);
  if (endLineEnd === -1) {
    endLineEnd = content.length;
  } else {
    endLineEnd += 1; // include the newline
  }
  return { start: startIdx, end: endLineEnd };
}

/**
 * Detect whether the TOML text declares an UNMARKED `[model_providers.<id>]`
 * table (i.e. one that is NOT inside our managed block). This is a collision:
 * the plugin must fail closed rather than overwrite user-authored config.
 */
export function hasUnmarkedProviderTable(
  content: string,
  providerId: string,
): boolean {
  const managed = findManagedBlock(content, providerId);
  // Escape regex metacharacters in the provider id.
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match either `[model_providers.<id>]` or `[model_providers.<id>.auth]`.
  const tableRe = new RegExp(
    `^\\s*\\[model_providers\\.${escaped}(?:\\.[A-Za-z0-9_-]+)?\\]`,
    "gm",
  );
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(content)) !== null) {
    const idx = match.index;
    // If the match falls inside our managed block, it is ours — skip it.
    if (managed && idx >= managed.start && idx < managed.end) {
      continue;
    }
    return true;
  }
  return false;
}

/** In-process lock registry keyed by absolute config path. */
const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with a bounded in-process lock for `key`, serializing concurrent
 * writers in the same process. Cross-process safety is provided by atomic
 * rename plus collision detection on read.
 */
async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(
    key,
    prior.then(() => gate),
  );
  await prior.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry when no newer writer is queued.
    if (fileLocks.get(key) === prior.then(() => gate)) {
      fileLocks.delete(key);
    }
  }
}

/** Read a file, returning "" when it does not exist. */
function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/**
 * Atomically write `content` to `filePath` with mode `0600`.
 * Writes to a temp sibling then renames.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  // Enforce mode on the final file (rename preserves temp's mode, but ensure
  // it if the target pre-existed with a different mode).
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort; some filesystems may not support chmod
  }
}

/**
 * Splice a new managed block into (or update it within) existing TOML text.
 * Pure text transform; does not touch the filesystem.
 *
 * @returns the resulting TOML text
 * @throws when an unmarked provider table collision is detected
 */
export function reconcileBlockText(
  content: string,
  opts: CodexProviderBlockOptions,
): string {
  if (hasUnmarkedProviderTable(content, opts.providerId)) {
    throw new Error(
      `Codex config already declares an unmanaged [model_providers.${opts.providerId}] table; refusing to overwrite.`,
    );
  }
  const block = buildManagedBlock(opts);
  const existing = findManagedBlock(content, opts.providerId);
  if (existing) {
    // Replace the existing managed block in place.
    const before = content.slice(0, existing.start);
    const after = content.slice(existing.end);
    // Preserve a single trailing newline after the block.
    const afterTrimmed = after.replace(/^\n+/, after.startsWith("\n") ? "\n" : "");
    return `${before}${block}\n${afterTrimmed.replace(/^\n/, "")}`;
  }
  // Append the new block, ensuring separation from prior content.
  if (content.length === 0) {
    return `${block}\n`;
  }
  const sep = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${sep}${block}\n`;
}

/**
 * Reconcile (insert or update) the managed Codex provider block inside the
 * `config.toml` at `configPath`. Idempotent: repeated calls with the same
 * inputs produce byte-identical output.
 *
 * @throws when an unmarked provider table collision is detected
 */
export async function reconcileCodexProviderBlock(
  configPath: string,
  opts: CodexProviderBlockOptions,
): Promise<void> {
  await withFileLock(configPath, async () => {
    const content = readIfExists(configPath);
    const next = reconcileBlockText(content, opts);
    if (next === content) {
      return;
    }
    atomicWrite(configPath, next);
  });
}

/**
 * Remove the plugin's managed block for `providerId` from `content`.
 * Unrelated user TOML is preserved. Returns the resulting text (unchanged when
 * no managed block is present).
 */
export function removeBlockText(content: string, providerId: string): string {
  const existing = findManagedBlock(content, providerId);
  if (!existing) {
    return content;
  }
  const before = content.slice(0, existing.start);
  const after = content.slice(existing.end);
  // Collapse a doubled blank line left behind by the removal.
  const joined = `${before}${after}`;
  return joined.replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove the managed Codex provider block for `providerId` from the
 * `config.toml` at `configPath`. No-op when the file or block is absent.
 */
export async function removeCodexProviderBlock(
  configPath: string,
  providerId: string,
): Promise<boolean> {
  return withFileLock(configPath, async () => {
    const content = readIfExists(configPath);
    if (!content) {
      return false;
    }
    const next = removeBlockText(content, providerId);
    if (next === content) {
      return false;
    }
    atomicWrite(configPath, next);
    return true;
  });
}
