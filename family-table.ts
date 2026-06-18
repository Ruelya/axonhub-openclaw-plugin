// Family table for AxonHub-proxied reasoning models.
//
// AxonHub's `/v1/models` API does not expose per-model effort-level metadata
// (only `capabilities.reasoning: bool`). This module owns the
// (`model id pattern` → reasoning capability) mapping the plugin uses to:
//
// 1. Build the OpenClaw thinking-profile (UI levels list).
// 2. Decide whether to inject `reasoning_effort: max` via wrapStreamFn.
// 3. Fill `compat.supportedReasoningEfforts` so OpenClaw's transport layer
//    does not silently downgrade `xhigh`/`max` to `high`.
//
// Why we set `supportedEffortsForCompat` for ALL families that support xhigh
// or max (including OpenAI gpt-5/o3/o4-mini):
// - OpenClaw's built-in OpenAI registry
//   (`src/agents/openai-reasoning-effort.ts`) does NOT handle `o3` / `o4-mini`
//   (they fall through to a generic `["low","medium","high"]` table) and its
//   `OpenAIReasoningEffort` type has never included `"max"` at all. Relying
//   on the built-in registry strips xhigh from o3/o4-mini and strips max
//   from every OpenAI model.
// - When `compat.supportedReasoningEfforts` is set on the model entry,
//   OpenClaw's `readCompatReasoningEfforts` (which is checked FIRST, before
//   the id-pattern table) accepts the list verbatim, so we get full
//   xhigh+max coverage transport-side regardless of provider family.
//
// Forward-compat: if AxonHub later exposes per-model effort lists in
// `capabilities.reasoning_efforts` (or similar), `readApiReasoningEfforts`
// reads them and the catalog code prefers them over the family table.

import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const STANDARD_EFFORTS_WITH_XHIGH = ["low", "medium", "high", "xhigh"] as const;
const STANDARD_EFFORTS_WITH_MAX = ["low", "medium", "high", "xhigh", "max"] as const;
const STANDARD_EFFORTS_WITH_MAX_NO_XHIGH = ["low", "medium", "high", "max"] as const;

const BASE_LEVELS_OFF_TO_HIGH = [
  { id: "off" as const, label: "off", rank: 0 },
  { id: "minimal" as const, label: "minimal", rank: 10 },
  { id: "low" as const, label: "low", rank: 20 },
  { id: "medium" as const, label: "medium", rank: 30 },
  { id: "high" as const, label: "high", rank: 40 },
];

const PROFILE_OFF_TO_MAX: ProviderThinkingProfile = {
  levels: [
    ...BASE_LEVELS_OFF_TO_HIGH,
    { id: "xhigh" as const, label: "xhigh", rank: 60 },
    { id: "max" as const, label: "max", rank: 70 },
  ],
};

const PROFILE_OFF_TO_XHIGH: ProviderThinkingProfile = {
  levels: [
    ...BASE_LEVELS_OFF_TO_HIGH,
    { id: "xhigh" as const, label: "xhigh", rank: 60 },
  ],
};

const PROFILE_BASE_ONLY: ProviderThinkingProfile = {
  levels: [...BASE_LEVELS_OFF_TO_HIGH],
};

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" as const, label: "off", rank: 0 },
  { id: "minimal" as const, label: "minimal", rank: 10 },
  { id: "low" as const, label: "low", rank: 20 },
  { id: "medium" as const, label: "medium", rank: 30 },
  { id: "high" as const, label: "high", rank: 40 },
];

type ClaudeModelRef = {
  id?: string;
  params?: Record<string, unknown>;
};

function normalizeClaudeModelId(modelId?: string): string {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

function resolveClaudeModelIdentity(ref: ClaudeModelRef): string {
  const configuredCanonicalModelId =
    typeof ref.params?.canonicalModelId === "string" ? ref.params.canonicalModelId : undefined;
  const normalized = normalizeClaudeModelId(configuredCanonicalModelId ?? ref.id);
  const match = /(?:^|[-/])claude-/.exec(normalized);
  return match
    ? normalized.slice((match.index ?? 0) + (match[0].startsWith("claude-") ? 0 : 1))
    : normalized;
}

function resolveClaudeFable5ModelIdentity(ref: ClaudeModelRef): string | undefined {
  const normalized = resolveClaudeModelIdentity(ref);
  const match = /(?:^|-)claude-fable-5(?=$|[^a-z0-9])/.exec(normalized);
  if (!match) {
    return undefined;
  }
  return normalized.slice((match.index ?? 0) + (match[0].startsWith("-") ? 1 : 0));
}

function supportsClaudeAdaptiveThinking(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return /(?:^|-)claude-(?:fable-5|mythos-preview|opus-4-(?:6|7|8)|sonnet-4-6)(?=$|[^a-z0-9])/.test(
    modelId,
  );
}

function supportsClaudeNativeXhighEffort(ref: ClaudeModelRef): boolean {
  const modelId = resolveClaudeModelIdentity(ref);
  return /(?:^|-)claude-(?:fable-5|opus-4-(?:7|8))(?=$|[^a-z0-9])/.test(modelId);
}

function isClaudeAdaptiveThinkingDefaultModelId(modelId: string): boolean {
  const ref = { id: modelId };
  return supportsClaudeAdaptiveThinking(ref) && !supportsClaudeNativeXhighEffort(ref);
}

/** Plugin-owned Claude profile resolver (mirrors OpenClaw llm-core contracts). */
function resolveAxonhubClaudeThinkingProfile(
  modelId: string,
  params?: Record<string, unknown>,
  options?: { includeNativeMax?: boolean },
): ProviderThinkingProfile {
  const ref = { id: modelId, params };
  const canonicalModelId = resolveClaudeModelIdentity(ref);
  if (resolveClaudeFable5ModelIdentity(ref)) {
    return {
      levels: [
        ...BASE_CLAUDE_THINKING_LEVELS,
        { id: "xhigh" as const, label: "xhigh", rank: 60 },
        { id: "adaptive" as const, label: "adaptive", rank: 50 },
        { id: "max" as const, label: "max", rank: 70 },
      ],
      defaultLevel: "high",
    };
  }
  if (supportsClaudeNativeXhighEffort(ref)) {
    return {
      levels: [
        ...BASE_CLAUDE_THINKING_LEVELS,
        { id: "xhigh" as const, label: "xhigh", rank: 60 },
        { id: "adaptive" as const, label: "adaptive", rank: 50 },
        { id: "max" as const, label: "max", rank: 70 },
      ],
      defaultLevel: "off",
    };
  }
  if (isClaudeAdaptiveThinkingDefaultModelId(canonicalModelId)) {
    return {
      levels: [
        ...BASE_CLAUDE_THINKING_LEVELS,
        { id: "adaptive" as const, label: "adaptive", rank: 50 },
        ...(options?.includeNativeMax ? [{ id: "max" as const, label: "max", rank: 70 }] : []),
      ],
      defaultLevel: "adaptive",
    };
  }
  return { levels: [...BASE_CLAUDE_THINKING_LEVELS] };
}

const AXONHUB_DEEPSEEK_V4_MODEL_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export type AxonhubReasoningFamily = {
  /** Stable identifier for logs / tests. */
  family: string;
  /** Thinking profile to expose to OpenClaw UI. */
  profile: ProviderThinkingProfile;
  /** Whether `xhigh` is in the profile's levels list. */
  supportsXHigh: boolean;
  /** Whether `wrapStreamFn` should inject `reasoning_effort: max` for this family. */
  supportsMax: boolean;
  /**
   * Optional compat.supportedReasoningEfforts to set on the model's catalog
   * entry. Use this for families where OpenClaw's transport-level downgrade
   * would otherwise drop xhigh (e.g. Anthropic / DeepSeek / Gemini). Leave
   * undefined for OpenAI families that OpenClaw's built-in registry already
   * handles by id pattern.
   */
  supportedEffortsForCompat?: readonly string[];
};

/** Strip the `axonhub/` namespace prefix and lowercase. */
export function normalizeAxonhubModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/^axonhub\//, "");
}

export function isAxonhubDeepSeekV4ModelId(modelId: string): boolean {
  const normalized = normalizeAxonhubModelId(modelId);
  return (AXONHUB_DEEPSEEK_V4_MODEL_IDS as readonly string[]).includes(normalized);
}

function isOpenAiGpt5OrOSeriesId(normalized: string): boolean {
  return /^(?:gpt-5|o3|o4-mini)/i.test(normalized);
}

function isGoogleGemini3Id(normalized: string): boolean {
  return /^gemini-3/i.test(normalized);
}

function profileSupportsLevel(profile: ProviderThinkingProfile, levelId: string): boolean {
  return profile.levels.some((level) => level.id === levelId);
}

/**
 * Resolve the reasoning family for a given AxonHub model id, returning the
 * thinking profile and capability flags. Returns null for ids that don't
 * match any known family.
 */
export function resolveAxonhubFamily(modelId: string): AxonhubReasoningFamily | null {
  const normalized = normalizeAxonhubModelId(modelId);

  // Output-driven Claude family detection using plugin-owned llm-core-style
  // contracts instead of the deprecated provider-owned SDK helper.
  const claudeProfile = resolveAxonhubClaudeThinkingProfile(normalized);
  const claudeSupportsMax = profileSupportsLevel(claudeProfile, "max");
  const claudeSupportsAdaptive = profileSupportsLevel(claudeProfile, "adaptive");

  // Anthropic Claude opus-4.7 / mythos — xhigh + adaptive + max.
  // `claude-mythos-preview` is handled via adaptive-thinking detection; keep
  // the inline full profile when max is not inferred from the resolver.
  if (claudeSupportsMax || normalized === "claude-mythos-preview") {
    const profile: ProviderThinkingProfile = claudeSupportsMax
      ? claudeProfile
      : {
          levels: [
            ...BASE_LEVELS_OFF_TO_HIGH,
            { id: "xhigh" as const, label: "xhigh", rank: 60 },
            { id: "adaptive" as const, label: "adaptive", rank: 50 },
            { id: "max" as const, label: "max", rank: 70 },
          ],
          defaultLevel: "off",
        };
    return {
      family: "anthropic-claude-4.7",
      profile,
      supportsXHigh: true,
      supportsMax: true,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_MAX],
    };
  }

  // Anthropic Claude opus-4.6 / sonnet-4.6 — adaptive + max, no xhigh.
  // The Claude 4.6 profile includes adaptive but not max; we append max
  // manually because AxonHub's Anthropic transformer accepts it upstream.
  if (claudeSupportsAdaptive) {
    const profile: ProviderThinkingProfile = {
      ...claudeProfile,
      levels: [
        ...claudeProfile.levels,
        { id: "max" as const, label: "max", rank: 70 },
      ],
    };
    return {
      family: "anthropic-claude-4.6",
      profile,
      supportsXHigh: false,
      supportsMax: true,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_MAX_NO_XHIGH],
    };
  }

  // OpenAI gpt-5.x / o3 / o4-mini — xhigh only.
  // No upstream max support for any OpenAI-family model routed through
  // AxonHub (as of 2026-05-05 the only models supporting max are Claude
  // 4.6/4.7/mythos and DeepSeek V4).
  if (isOpenAiGpt5OrOSeriesId(normalized)) {
    return {
      family: "openai-gpt5-or-o-series",
      profile: PROFILE_OFF_TO_XHIGH,
      supportsXHigh: true,
      supportsMax: false,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_XHIGH],
    };
  }

  // DeepSeek V4 — xhigh + max via wrapStreamFn (existing payload wrapper)
  if (isAxonhubDeepSeekV4ModelId(normalized)) {
    return {
      family: "deepseek-v4",
      profile: PROFILE_OFF_TO_MAX,
      supportsXHigh: true,
      supportsMax: true,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_MAX],
    };
  }

  // Google Gemini 3.x — xhigh only (AxonHub Gemini transformer maps xhigh,
  // no max upstream support)
  if (isGoogleGemini3Id(normalized)) {
    return {
      family: "google-gemini-3",
      profile: PROFILE_OFF_TO_XHIGH,
      supportsXHigh: true,
      supportsMax: false,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_XHIGH],
    };
  }

  return null;
}

/**
 * Forward-compat: read an optional per-model effort list from an AxonHub
 * `/v1/models` entry. AxonHub v0.9.38 does not expose this, but if a future
 * version surfaces `capabilities.reasoning_efforts` (or one of the alias
 * names), prefer the API-provided list over the family-table guess.
 */
export function readApiReasoningEfforts(
  modelEntry: { capabilities?: unknown } | undefined | null,
): readonly string[] | undefined {
  if (!modelEntry || typeof modelEntry !== "object") {
    return undefined;
  }
  const caps = (modelEntry as { capabilities?: unknown }).capabilities;
  if (!caps || typeof caps !== "object") {
    return undefined;
  }
  const candidateKeys = [
    "reasoning_efforts",
    "reasoning_effort_levels",
    "effort_levels",
    "reasoning_levels",
  ] as const;
  for (const key of candidateKeys) {
    const raw = (caps as Record<string, unknown>)[key];
    if (Array.isArray(raw)) {
      const list = raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
      if (list.length > 0) {
        return list;
      }
    }
  }
  return undefined;
}

/** Profile for an unknown reasoning model: 5 base levels (off..high). */
export const AXONHUB_BASE_REASONING_PROFILE: ProviderThinkingProfile = PROFILE_BASE_ONLY;

/**
 * Whether xhigh is exposed for the given model id. Used by the
 * `supportsXHighThinking` plugin hook.
 */
export function supportsAxonhubXHighThinking(modelId: string): boolean {
  const family = resolveAxonhubFamily(modelId);
  return family?.supportsXHigh === true;
}

/**
 * Whether the wrapStreamFn max-injection wrapper should activate for this
 * model id.
 */
export function supportsAxonhubMaxThinking(modelId: string): boolean {
  const family = resolveAxonhubFamily(modelId);
  return family?.supportsMax === true;
}
