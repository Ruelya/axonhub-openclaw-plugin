/**
 * Normalized AxonHub model types.
 *
 * Separates three layers that were previously mixed inside `index.ts`:
 *
 * 1. `AxonhubRawModelEntry` — the wire shape returned by AxonHub's
 *    `/v1/models` (and `/v1/models?include=all`) endpoints.
 * 2. `DiscoveredModel` — a normalized, validated instance model, independent of
 *    any protocol/reasoning decision.
 * 3. `EnrichedModel` — a `DiscoveredModel` plus the resolved protocol family,
 *    OpenClaw `api`/`baseUrl` transport, and reasoning metadata used by the
 *    catalog, dynamic resolution, onboarding, and thinking profiles.
 */

import type { ModelApi } from "openclaw/plugin-sdk/provider-model-shared";

export type { ModelApi };

/** Protocol family the plugin routes an AxonHub model through. */
export type AxonhubProtocolFamily =
  | "gemini"
  | "anthropic"
  | "openai-responses"
  | "openai-completions";

/** Capability block from AxonHub `/v1/models`. */
export type AxonhubCapabilities = {
  vision?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  // Forward-compat: AxonHub does not expose these today, but if a future
  // version adds a per-model effort list the plugin reads it via
  // readApiReasoningEfforts.
  reasoning_efforts?: string[];
  reasoning_effort_levels?: string[];
  effort_levels?: string[];
  reasoning_levels?: string[];
};

/** Pricing block from AxonHub `/v1/models`. */
export type AxonhubPricing = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  unit?: string;
  currency?: string;
};

/** Raw wire entry from AxonHub `/v1/models` (basic or extended). */
export type AxonhubRawModelEntry = {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: AxonhubCapabilities;
  pricing?: AxonhubPricing;
  type?: string;
  icon?: string;
};

/** Raw AxonHub `/v1/models` response envelope. */
export type AxonhubModelsResponse = {
  object?: string;
  data?: AxonhubRawModelEntry[];
};

/** Normalized per-model cost, in USD per million tokens. */
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * A validated, normalized AxonHub instance model, before protocol/reasoning
 * enrichment. This is what the discovery/cache service produces.
 */
export type DiscoveredModel = {
  /** Canonical model id (namespace prefix stripped, trimmed). */
  id: string;
  /** Human display name. */
  name: string;
  /** AxonHub `owned_by`, lowercased, when present. */
  owner?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  vision: boolean;
  input: Array<"text" | "image">;
  cost: ModelCost;
  /**
   * Per-model `compat.supportedReasoningEfforts`, when a source has an opinion.
   * Undefined lets OpenClaw transport auto-detect via id pattern.
   */
  supportedReasoningEfforts?: readonly string[];
};

/**
 * A `DiscoveredModel` with the resolved transport and reasoning metadata. This
 * single record feeds catalog rows, stored config, dynamic resolution, and
 * thinking-profile resolution so those paths cannot drift.
 */
export type EnrichedModel = DiscoveredModel & {
  /** Resolved protocol family. */
  protocolFamily: AxonhubProtocolFamily;
  /** OpenClaw model-level `api` adapter. */
  api: ModelApi;
  /** OpenClaw model-level `baseUrl` (protocol-specific AxonHub endpoint). */
  baseUrl: string;
};
