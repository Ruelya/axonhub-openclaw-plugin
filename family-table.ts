// Family table for AxonHub-proxied reasoning models.
//
// AxonHub's `/v1/models` API does not expose per-model effort-level metadata
// (only `capabilities.reasoning: bool`). This module owns the
// (`model id pattern` → reasoning capability) mapping the plugin uses to:
//
// 1. Build the OpenClaw thinking-profile (UI levels list).
// 2. Decide whether to inject `reasoning_effort: max` via wrapStreamFn.
// 3. Optionally fill `compat.supportedReasoningEfforts` to override OpenClaw's
//    built-in OpenAI family registry default for non-OpenAI families.
//
// Notes on coverage:
// - OpenClaw's built-in OpenAI registry (`src/agents/openai-reasoning-effort.ts`)
//   already handles `gpt-5*`, `gpt-5.x-codex`, `gpt-5.x-pro`, `o3`, `o4-mini`
//   by id pattern. We still register OpenAI here so the UI/wrapStreamFn paths
//   know about xhigh/max, but we leave `supportedEffortsForCompat` undefined
//   so we don't double-define.
// - For non-OpenAI families with xhigh support (Anthropic 4.7, DeepSeek V4,
//   Gemini 3.x), we set `supportedEffortsForCompat` so OpenClaw's transport
//   layer doesn't silently downgrade `xhigh → high`.
//
// Forward-compat: if AxonHub later exposes per-model effort lists in
// `capabilities.reasoning_efforts` (or similar), `readApiReasoningEfforts`
// reads them and the catalog code prefers them over the family table.

import {
  isClaudeAdaptiveThinkingDefaultModelId,
  isClaudeOpus47ModelId,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const STANDARD_EFFORTS_WITH_XHIGH = ["low", "medium", "high", "xhigh"] as const;

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

  // Anthropic Claude opus-4.7 / sonnet-4.7 — xhigh + adaptive + max
  if (isClaudeOpus47ModelId(normalized)) {
    const profile = resolveClaudeThinkingProfile(normalized);
    return {
      family: "anthropic-claude-4.7",
      profile,
      supportsXHigh: profileSupportsLevel(profile, "xhigh"),
      supportsMax: profileSupportsLevel(profile, "max"),
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_XHIGH],
    };
  }

  // Anthropic Claude opus-4.6 / sonnet-4.6 — adaptive only (no xhigh, no max)
  if (isClaudeAdaptiveThinkingDefaultModelId(normalized)) {
    const profile = resolveClaudeThinkingProfile(normalized);
    return {
      family: "anthropic-claude-4.6",
      profile,
      supportsXHigh: profileSupportsLevel(profile, "xhigh"),
      supportsMax: profileSupportsLevel(profile, "max"),
      // No compat override — profile lacks xhigh, so OpenClaw default is fine.
    };
  }

  // OpenAI gpt-5.x / o3 / o4-mini — xhigh + max via wrapStreamFn
  // OpenClaw's built-in OpenAI family registry already gates effort filtering
  // by id pattern, so we deliberately do not set supportedEffortsForCompat.
  if (isOpenAiGpt5OrOSeriesId(normalized)) {
    return {
      family: "openai-gpt5-or-o-series",
      profile: PROFILE_OFF_TO_MAX,
      supportsXHigh: true,
      supportsMax: true,
    };
  }

  // DeepSeek V4 — xhigh + max via wrapStreamFn (existing payload wrapper)
  if (isAxonhubDeepSeekV4ModelId(normalized)) {
    return {
      family: "deepseek-v4",
      profile: PROFILE_OFF_TO_MAX,
      supportsXHigh: true,
      supportsMax: true,
      supportedEffortsForCompat: [...STANDARD_EFFORTS_WITH_XHIGH],
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
