/**
 * AxonHub model discovery and cache service.
 *
 * Provides one service used by onboarding, provider catalog, unified live
 * catalog, CLI sync, and dynamic-model preparation. Implements credential-scoped
 * caching with TTL freshness, stale-on-error behavior, and atomic writes.
 *
 * Design.md § 3: AxonHub model sync service.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readApiReasoningEfforts } from "./family-table.js";
import { enrichModel } from "./model-metadata.js";
import type {
  AxonhubModelsResponse,
  AxonhubRawModelEntry,
  DiscoveredModel,
  EnrichedModel,
} from "./model-types.js";
import {
  getAxonhubOpenAIEndpoint,
  normalizeAxonhubInstanceRoot,
} from "./url-helpers.js";

/** Default TTL: 1 hour, aligns with AxonHub's hourly channel model sync. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Schema version for cache records. Bump when structure changes. */
const CACHE_SCHEMA_VERSION = 1;

/** Normalized cost in USD per million tokens. */
type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Normalize a discovered model from AxonHub's wire entry. Validates, strips
 * invalid ids, and applies cost defaults.
 */
function normalizeRawModelEntry(
  raw: AxonhubRawModelEntry,
): DiscoveredModel | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  // Only include chat-type models
  if (raw.type && raw.type !== "chat") return null;

  const hasVision = raw.capabilities?.vision === true;

  // Cost: AxonHub already reports pricing per 1M tokens (Unit "per_1m_tokens"),
  // which matches what OpenClaw's catalog expects. Pass through unchanged to
  // preserve the pre-refactor behavior of `fetchAxonhubModels`.
  const pricing = raw.pricing;
  const cost: ModelCost = {
    input: pricing?.input ?? 0,
    output: pricing?.output ?? 0,
    cacheRead: pricing?.cache_read ?? 0,
    cacheWrite: pricing?.cache_write ?? 0,
  };

  const supportedReasoningEfforts = readApiReasoningEfforts(raw);

  return {
    id,
    name: raw.display_name?.trim() || raw.name?.trim() || id,
    owner: raw.owned_by?.toLowerCase().trim(),
    contextWindow:
      typeof raw.context_length === "number" && raw.context_length > 0
        ? raw.context_length
        : undefined,
    maxTokens:
      typeof raw.max_output_tokens === "number" && raw.max_output_tokens > 0
        ? raw.max_output_tokens
        : undefined,
    reasoning: raw.capabilities?.reasoning === true,
    vision: hasVision,
    input: hasVision ? ["text", "image"] : ["text"],
    cost,
    supportedReasoningEfforts,
  };
}

/** SHA-256 over normalized root + credential, short digest for filenames. */
function computeCredentialFingerprint(
  normalizedRoot: string,
  apiKey: string,
): string {
  const hash = createHash("sha256");
  hash.update(normalizedRoot);
  hash.update("\x00");
  hash.update(apiKey);
  return hash.digest("hex").slice(0, 16);
}

/** In-memory cache record. */
type CacheRecord = {
  schema: number;
  normalizedRoot: string;
  fingerprint: string;
  fetchedAt: number;
  models: EnrichedModel[];
};

/** In-memory cache: fingerprint → record. */
const memoryCache = new Map<string, CacheRecord>();

/** Disk cache shape (JSON). */
type DiskCacheRecord = {
  schema: number;
  normalizedRoot: string;
  fingerprint: string;
  fetchedAt: number;
  models: EnrichedModel[];
};

/** Fetch status flags. */
type FetchStatus = {
  fresh: boolean;
  stale: boolean;
  error?: string;
};

/** Discovery service result. */
export type ModelSyncResult = {
  models: EnrichedModel[];
  status: FetchStatus;
};

/** Discovery service inputs. */
export type ModelSyncParams = {
  /** Normalized AxonHub API root (e.g. "http://localhost:8090"). */
  instanceRoot: string;
  /** Resolved API key (never logged or persisted). */
  apiKey: string;
  /** Optional auth profile id (for diagnostics only, not stored). */
  profileId?: string;
  /** Agent directory for agent-scoped disk cache. */
  agentDir?: string;
  /** Force refresh, bypass TTL. */
  forceRefresh?: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** TTL in milliseconds (default 1 hour). */
  ttlMs?: number;
};

/**
 * Parse an AxonHub models HTTP response into a `data` array.
 *
 * AxonHub's instance root often serves a SPA for unknown paths (HTTP 200 +
 * HTML). Only accept JSON bodies with a `data` array so HTML never counts as a
 * successful models payload.
 */
async function parseModelsResponse(
  res: Response,
): Promise<AxonhubRawModelEntry[] | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return null;
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) {
    return null;
  }

  try {
    const json = JSON.parse(trimmed) as AxonhubModelsResponse;
    return Array.isArray(json.data) ? json.data : null;
  } catch {
    return null;
  }
}

/**
 * Fetch and merge `/v1/models` and `/v1/models?include=all`. Accept either on
 * partial success and merge fields by model id.
 *
 * `params.baseUrl` is the AxonHub **instance root** (no `/v1` suffix). The OpenAI
 * models API lives under `/v1`; requesting `/models` on the root returns SPA HTML
 * on many deployments.
 */
async function fetchAxonhubModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<AxonhubRawModelEntry[]> {
  const apiBase = getAxonhubOpenAIEndpoint(params.baseUrl);
  const basicUrl = `${apiBase}/models`;
  const extendedUrl = `${apiBase}/models?include=all`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const [basicRes, extendedRes] = await Promise.allSettled([
      fetch(basicUrl, {
        headers: { Authorization: `Bearer ${params.apiKey}` },
        signal: controller.signal,
      }),
      fetch(extendedUrl, {
        headers: { Authorization: `Bearer ${params.apiKey}` },
        signal: controller.signal,
      }),
    ]);

    clearTimeout(timeout);

    let basicData: AxonhubRawModelEntry[] = [];
    let extendedData: AxonhubRawModelEntry[] = [];
    let anyOk = false;

    if (basicRes.status === "fulfilled" && basicRes.value.ok) {
      const data = await parseModelsResponse(basicRes.value);
      if (data) {
        anyOk = true;
        basicData = data;
      }
    }

    if (extendedRes.status === "fulfilled" && extendedRes.value.ok) {
      const data = await parseModelsResponse(extendedRes.value);
      if (data) {
        anyOk = true;
        extendedData = data;
      }
    }

    // Neither endpoint returned a usable JSON models payload. Treat this as a
    // transient fetch failure so the caller can fall back to a stale cache rather
    // than caching an empty result. A successful 200 with an empty `data` array
    // is legitimately empty and does NOT reach this branch.
    if (!anyOk) {
      throw new Error(
        `AxonHub models API returned no usable JSON (tried ${basicUrl} and ${extendedUrl})`,
      );
    }

    // Merge: extended fields take precedence over basic.
    const merged = new Map<string, AxonhubRawModelEntry>();
    for (const entry of basicData) {
      if (entry.id) {
        merged.set(entry.id, entry);
      }
    }
    for (const entry of extendedData) {
      if (entry.id) {
        const existing = merged.get(entry.id);
        merged.set(entry.id, existing ? { ...existing, ...entry } : entry);
      }
    }

    return Array.from(merged.values());
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Load disk cache for the given agent directory and fingerprint. Returns null
 * if not found, invalid, or schema mismatch.
 */
async function loadDiskCache(
  agentDir: string,
  fingerprint: string,
): Promise<CacheRecord | null> {
  try {
    const cacheDir = join(agentDir, ".axonhub-model-cache");
    const cachePath = join(cacheDir, `${fingerprint}.json`);
    const content = await readFile(cachePath, "utf8");
    const disk = JSON.parse(content) as DiskCacheRecord;

    if (disk.schema !== CACHE_SCHEMA_VERSION) {
      return null;
    }
    if (disk.fingerprint !== fingerprint) {
      return null;
    }

    return disk;
  } catch {
    return null;
  }
}

/**
 * Write disk cache atomically with mode 0600. Creates cache directory if needed.
 */
async function writeDiskCache(
  agentDir: string,
  record: CacheRecord,
): Promise<void> {
  const cacheDir = join(agentDir, ".axonhub-model-cache");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });

  const cachePath = join(cacheDir, `${record.fingerprint}.json`);
  const tempPath = `${cachePath}.tmp`;

  await writeFile(tempPath, JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  await rename(tempPath, cachePath);
}

/**
 * Synchronous lookup of a cached enriched model by instance root and model id.
 *
 * Used by the synchronous `resolveDynamicModel` path, which cannot await. It
 * scans the in-memory cache for any credential-scoped record matching the
 * normalized root and returns the first model whose id matches. This works
 * because `prepareDynamicModel` warms the memory cache before the synchronous
 * retry. Returns undefined when no warm entry exists (caller falls back to a
 * conservative metadata-derived model).
 */
export function findCachedEnrichedModel(
  instanceRoot: string,
  modelId: string,
): EnrichedModel | undefined {
  const normalizedRoot = normalizeAxonhubInstanceRoot(instanceRoot);
  const wanted = modelId.trim();
  for (const record of memoryCache.values()) {
    if (record.normalizedRoot !== normalizedRoot) continue;
    const found = record.models.find((m) => m.id === wanted);
    if (found) return found;
  }
  return undefined;
}

/**
 * Read the currently-cached models for a credential scope WITHOUT fetching.
 *
 * Checks the in-memory cache first, then the agent-scoped disk cache. Returns
 * an empty array when no cache entry exists. Used by the CLI `sync` command to
 * capture the "before" snapshot so a forced refresh can be diffed against the
 * prior cached state instead of triggering a network fetch that would make the
 * diff meaningless. Never fetches, never throws.
 */
export async function peekCachedModels(params: {
  instanceRoot: string;
  apiKey: string;
  agentDir?: string;
}): Promise<EnrichedModel[]> {
  const normalizedRoot = normalizeAxonhubInstanceRoot(params.instanceRoot);
  const fingerprint = computeCredentialFingerprint(
    normalizedRoot,
    params.apiKey,
  );

  const memCached = memoryCache.get(fingerprint);
  if (memCached) {
    return memCached.models;
  }

  if (params.agentDir) {
    const diskCached = await loadDiskCache(params.agentDir, fingerprint);
    if (diskCached) {
      return diskCached.models;
    }
  }

  return [];
}

/**
 * Shared AxonHub model discovery and cache service.
 *
 * Fetches instance-visible models, enriches them with protocol/reasoning
 * metadata, and caches results with credential-scoped identity. Used by
 * onboarding, catalog, dynamic resolution, and CLI sync.
 *
 * Cache identity: SHA-256(normalizedRoot + apiKey), with only a short digest
 * stored in filenames. TTL freshness: 1 hour default. Stale-on-error: returns
 * stale cache with status flag on transient fetch failure; returns empty +
 * diagnostic state when no cache exists.
 *
 * @param params - discovery inputs
 * @returns models and fetch status
 */
export async function syncAxonhubModels(
  params: ModelSyncParams,
): Promise<ModelSyncResult> {
  const normalizedRoot = normalizeAxonhubInstanceRoot(params.instanceRoot);
  const fingerprint = computeCredentialFingerprint(
    normalizedRoot,
    params.apiKey,
  );
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = params.timeoutMs ?? 5000;
  const now = Date.now();

  // Check memory cache first (hot path). A fresh entry short-circuits unless a
  // forced refresh was requested.
  const memCached = memoryCache.get(fingerprint);
  if (!params.forceRefresh && memCached && now - memCached.fetchedAt < ttl) {
    return {
      models: memCached.models,
      status: { fresh: true, stale: false },
    };
  }

  // Load disk cache when an agent directory is available. This is always loaded
  // (even on forced refresh) so it can back the stale-on-error fallback below.
  let diskCached: CacheRecord | null = null;
  if (params.agentDir) {
    diskCached = await loadDiskCache(params.agentDir, fingerprint);
    if (!params.forceRefresh && diskCached && now - diskCached.fetchedAt < ttl) {
      // Fresh disk cache: promote to memory.
      memoryCache.set(fingerprint, diskCached);
      return {
        models: diskCached.models,
        status: { fresh: true, stale: false },
      };
    }
  }

  // Fetch from AxonHub.
  try {
    const rawEntries = await fetchAxonhubModels({
      baseUrl: normalizedRoot,
      apiKey: params.apiKey,
      timeoutMs,
    });

    // Normalize and enrich.
    const discovered = rawEntries
      .map(normalizeRawModelEntry)
      .filter((m): m is DiscoveredModel => m !== null);

    const enriched = discovered
      .map((d) => enrichModel(d, normalizedRoot))
      .sort((a, b) => a.id.localeCompare(b.id));

    const record: CacheRecord = {
      schema: CACHE_SCHEMA_VERSION,
      normalizedRoot,
      fingerprint,
      fetchedAt: now,
      models: enriched,
    };

    // Update memory cache.
    memoryCache.set(fingerprint, record);

    // Update disk cache.
    if (params.agentDir) {
      await writeDiskCache(params.agentDir, record).catch(() => {
        // Ignore disk write errors; memory cache is primary.
      });
    }

    return {
      models: enriched,
      status: { fresh: true, stale: false },
    };
  } catch (err) {
    // Stale-on-error: return stale cache if available (disk or memory).
    const stale = diskCached ?? memCached;
    if (stale) {
      return {
        models: stale.models,
        status: {
          fresh: false,
          stale: true,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // No cache: return empty with diagnostic state.
    return {
      models: [],
      status: {
        fresh: false,
        stale: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
