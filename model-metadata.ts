/**
 * Model metadata resolver.
 *
 * Resolves protocol family and reasoning metadata for AxonHub models using
 * explicit metadata from the generated artifact, owner-aware matching, and
 * conservative fallback rules.
 *
 * Resolution precedence (design.md § 1):
 * 1. Future explicit AxonHub protocol/reasoning fields (forward-compat).
 * 2. Exact owner-alias + model-id match in the generated index.
 * 3. Unambiguous exact model-id match (no owner collision).
 * 4. Narrow owner/model-family rules.
 * 5. Conservative OpenAI-compatible Chat Completions fallback.
 */

import {
  MODEL_METADATA_RECORDS,
  OWNER_ALIASES,
  OWNER_PROTOCOL_FAMILIES,
  type ModelMetadataRecord,
} from "./model-metadata.generated.js";
import { resolveAxonhubFamily } from "./family-table.js";
import type { AxonhubProtocolFamily, ModelApi } from "./model-types.js";
import type { DiscoveredModel, EnrichedModel } from "./model-types.js";
import {
  getAxonhubAnthropicEndpoint,
  getAxonhubGeminiEndpoint,
  getAxonhubOpenAIEndpoint,
  normalizeAxonhubInstanceRoot,
} from "./url-helpers.js";

/**
 * Normalize a model id for matching: lowercase, strip `axonhub/` prefix if present.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/^axonhub\//, "");
}

/**
 * Normalize an owner string for matching: lowercase, map known aliases.
 */
function normalizeOwner(owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  const lower = owner.toLowerCase().trim();
  return OWNER_ALIASES[lower] ?? lower;
}

/**
 * Build an in-memory index: model id → metadata records.
 * Records are grouped by id, accounting for both canonical id and aliases.
 */
function buildMetadataIndex(): Map<string, ModelMetadataRecord[]> {
  const index = new Map<string, ModelMetadataRecord[]>();
  for (const record of MODEL_METADATA_RECORDS) {
    const ids = [record.id, ...(record.aliases ?? [])];
    for (const id of ids) {
      const existing = index.get(id);
      if (existing) {
        existing.push(record);
      } else {
        index.set(id, [record]);
      }
    }
  }
  return index;
}

// Lazy index built on first resolve.
let metadataIndex: Map<string, ModelMetadataRecord[]> | undefined;

function getMetadataIndex(): Map<string, ModelMetadataRecord[]> {
  if (!metadataIndex) {
    metadataIndex = buildMetadataIndex();
  }
  return metadataIndex;
}

/**
 * Resolve metadata for a model id and optional owner.
 *
 * Precedence:
 * 1. Owner-aware match (when owner is present).
 * 2. Unambiguous id match (exactly one record, no owner collision).
 * 3. No match → undefined.
 */
function resolveMetadata(
  modelId: string,
  owner: string | undefined,
): ModelMetadataRecord | undefined {
  const normalized = normalizeModelId(modelId);
  const normalizedOwner = normalizeOwner(owner);
  const index = getMetadataIndex();
  const candidates = index.get(normalized);

  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  // Owner-aware match (precedence 2).
  if (normalizedOwner) {
    const byOwner = candidates.filter(
      (rec) => rec.owners && rec.owners.includes(normalizedOwner),
    );
    if (byOwner.length === 1) {
      return byOwner[0];
    }
    if (byOwner.length > 1) {
      // Ambiguous owner match: return the first (deterministic order from
      // generated artifact).
      return byOwner[0];
    }
  }

  // Unambiguous id match (precedence 3).
  if (candidates.length === 1) {
    return candidates[0];
  }

  // Ambiguous: no owner or multiple records with no owner constraint.
  // Fallback to undefined → caller uses owner-family or conservative default.
  return undefined;
}

/**
 * Resolve the protocol family for a model, using metadata index, owner rules,
 * and fallback.
 */
function resolveProtocolFamily(
  modelId: string,
  owner: string | undefined,
): AxonhubProtocolFamily {
  const normalized = normalizeModelId(modelId);
  const normalizedOwner = normalizeOwner(owner);

  // Precedence 2/3: explicit metadata record.
  const metadata = resolveMetadata(normalized, normalizedOwner);
  if (metadata) {
    return metadata.protocolFamily;
  }

  // Precedence 4: narrow owner-family rule.
  if (normalizedOwner && OWNER_PROTOCOL_FAMILIES[normalizedOwner]) {
    return OWNER_PROTOCOL_FAMILIES[normalizedOwner];
  }

  // Check id-based family patterns for known providers.
  if (
    normalized.startsWith("gemini-") ||
    normalized.startsWith("gemma-") ||
    normalized.startsWith("imagen-")
  ) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "anthropic";
  }

  // Precedence 5: conservative OpenAI-compatible Chat Completions fallback.
  // Unknown AxonHub models already work through `/v1`; routing them to
  // Anthropic without evidence would be more disruptive (differs from OpenCode
  // reference's broad Anthropic fallback).
  return "openai-completions";
}

/**
 * Map protocol family to OpenClaw `api` adapter.
 */
function protocolFamilyToApi(family: AxonhubProtocolFamily): ModelApi {
  switch (family) {
    case "gemini":
      return "google-generative-ai";
    case "anthropic":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "openai-completions":
      return "openai-completions";
  }
}

/**
 * Map protocol family to AxonHub endpoint.
 */
function protocolFamilyToEndpoint(
  family: AxonhubProtocolFamily,
  instanceRoot: string,
): string {
  const root = normalizeAxonhubInstanceRoot(instanceRoot);
  switch (family) {
    case "gemini":
      return getAxonhubGeminiEndpoint(root);
    case "anthropic":
      return getAxonhubAnthropicEndpoint(root);
    case "openai-responses":
    case "openai-completions":
      return getAxonhubOpenAIEndpoint(root);
  }
}

/**
 * Resolve reasoning efforts for catalog compat field.
 *
 * Precedence:
 * 1. API-provided list (forward-compat, stored in `DiscoveredModel`).
 * 2. Metadata record efforts.
 * 3. Family-table compatibility fallback (preserves existing coverage).
 * 4. Undefined → let OpenClaw transport auto-detect.
 */
function resolveSupportedReasoningEfforts(
  discovered: DiscoveredModel,
): readonly string[] | undefined {
  // Precedence 1: API-provided (forward-compat).
  if (discovered.supportedReasoningEfforts) {
    return discovered.supportedReasoningEfforts;
  }

  // Precedence 2: metadata record.
  const metadata = resolveMetadata(discovered.id, discovered.owner);
  if (metadata?.supportedReasoningEfforts) {
    return metadata.supportedReasoningEfforts;
  }

  // Precedence 3: family-table compatibility fallback. Preserves current
  // behavior for families that are not yet in the generated metadata artifact
  // (gpt-5/o-series, gemini-3, etc.) so xhigh/max coverage does not regress.
  const family = resolveAxonhubFamily(discovered.id);
  if (family?.supportedEffortsForCompat?.length) {
    return family.supportedEffortsForCompat;
  }

  // Precedence 4: undefined → OpenClaw transport auto-detect.
  return undefined;
}

/**
 * Enrich a discovered model with protocol family, routing, and reasoning metadata.
 *
 * @param discovered — the validated AxonHub instance model
 * @param instanceRoot — the normalized AxonHub base URL
 * @returns an enriched model ready for catalog/dynamic-resolution/thinking-profile use
 */
export function enrichModel(
  discovered: DiscoveredModel,
  instanceRoot: string,
): EnrichedModel {
  const protocolFamily = resolveProtocolFamily(discovered.id, discovered.owner);
  const api = protocolFamilyToApi(protocolFamily);
  const baseUrl = protocolFamilyToEndpoint(protocolFamily, instanceRoot);
  const supportedReasoningEfforts = resolveSupportedReasoningEfforts(discovered);

  return {
    ...discovered,
    protocolFamily,
    api,
    baseUrl,
    supportedReasoningEfforts,
  };
}
