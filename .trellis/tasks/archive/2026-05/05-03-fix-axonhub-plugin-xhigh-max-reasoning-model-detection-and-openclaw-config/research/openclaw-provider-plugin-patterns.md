# How other OpenClaw provider plugins handle xhigh/max reasoning detection

**Goal:** Map out the industry pattern across other provider plugins in the
OpenClaw repo so we can pick the right shape for AxonHub.

**TL;DR:**
- Most plugins use **hardcoded family registries** (model id prefix / regex
  → effort levels).
- **LM Studio** is the gold standard: it reads per-model
  `capabilities.reasoning.allowed_options` from the runtime API and emits
  `compat.supportedReasoningEfforts` directly.
- **OpenClaw built-in transport** (`src/agents/openai-reasoning-effort.ts`)
  already does **automatic graceful downgrade**: `xhigh → high` for unknown
  models, plus a built-in OpenAI family registry. This means **AxonHub
  doesn't strictly need to gate xhigh per model**: if exposed for an
  unsupported model, OpenClaw silently downgrades it before it leaves OpenClaw.
- The `max` effort is **NOT in pi-ai's ThinkingLevel union** — it's handled by
  per-plugin `wrapStreamFn` payload patches; OpenClaw's downgrade does not
  cover it. Setting max on an unsupported model risks a 400.

OpenClaw repo synced to upstream HEAD `361737d1f1` (`fix(tts): honor telephony voice overrides`).

## 1. Plugin-by-plugin survey

### 1.1 LM Studio — `extensions/lmstudio/` (gold standard, fully data-driven)

LM Studio's runtime API (`/api/v1/models`) exposes per-model:

```ts
type LmstudioModelWire = {
  capabilities?: {
    reasoning?: { allowed_options?: unknown; default?: unknown };
    ...
  };
  ...
};
```

The plugin reads `capabilities.reasoning.allowed_options` and constructs
`compat.supportedReasoningEfforts` + `reasoningEffortMap` from it
(`src/models.ts`):

```ts
function buildLmstudioReasoningCompat(allowedOptions: readonly string[])
    : ModelDefinitionConfig["compat"] | undefined {
  const supportedReasoningEfforts = resolveLmstudioTransportReasoningEfforts(allowedOptions);
  if (supportedReasoningEfforts.length === 0) return undefined;
  if (!supportedReasoningEfforts.some((option) => option !== "none")) return undefined;
  return {
    supportsReasoningEffort: true,
    supportedReasoningEfforts,
    reasoningEffortMap: buildLmstudioReasoningEffortMap(supportedReasoningEfforts),
  };
}
```

It also handles the `on/off` binary case (mapping to a full enabled effort
range) and uses `reasoningEffortMap` to translate OpenClaw's normalized levels
(`off`, `minimal`, `low`, ..., `adaptive`, `max`) into provider-specific
strings (`none`, `default`, etc.).

**Why we can't just copy this for AxonHub:** AxonHub's `/v1/models` returns
only `capabilities.reasoning: bool` — there is no `allowed_options` equivalent.

### 1.2 Groq — `extensions/groq/api.ts` (per-family hardcoded compat)

Groq has two reasoning family shapes and emits `supportedReasoningEfforts`
plus a `reasoningEffortMap` per family via the `contributeResolvedModelCompat`
hook:

```ts
const GROQ_QWEN_REASONING_EFFORTS = ["none", "default"] as const;
const GROQ_GPT_OSS_REASONING_EFFORTS = ["low", "medium", "high"] as const;

function resolveGroqReasoningCompatPatch(modelId): {...} | null {
  if (normalizeGroqModelId(modelId) === GROQ_QWEN3_32B_ID) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...GROQ_QWEN_REASONING_EFFORTS],
      reasoningEffortMap: GROQ_QWEN_REASONING_EFFORT_MAP,  // off→none, minimal→default, ..., max→default
    };
  }
  if (GROQ_GPT_OSS_REASONING_IDS.has(normalized)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...GROQ_GPT_OSS_REASONING_EFFORTS],
    };
  }
  return null;
}
```

Wired via `contributeResolvedModelCompat` at registration time:

```ts
api.registerProvider({
  id: "groq",
  ...
  contributeResolvedModelCompat: ({ modelId, model }) =>
    contributeGroqResolvedModelCompat({ modelId, model }),
});
```

### 1.3 OpenAI — `extensions/openai/thinking-policy.ts` (hardcoded id list, profile-only)

OpenAI plugin uses a hardcoded list and `resolveThinkingProfile`. It does
**not** set `compat.supportedReasoningEfforts` on its emitted models —
instead it relies on OpenClaw's built-in OpenAI family detection
(`resolveOpenAISupportedReasoningEfforts`).

```ts
const OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro",
  "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2",
] as const;

const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro",
  "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex",
] as const;

export function resolveOpenAIThinkingProfile(modelId: string) {
  return {
    levels: [
      ...OPENAI_THINKING_BASE_LEVELS,
      ...(matchesExactOrPrefix(modelId, OPENAI_XHIGH_MODEL_IDS)
        ? [{ id: "xhigh" as const }]
        : []),
    ],
  };
}
```

Notably: the OpenAI plugin **does not expose `max`** in its profile at all.

### 1.4 OpenRouter — `extensions/openrouter/thinking-policy.ts` (single-family pass-through)

OpenRouter is also a multi-provider gateway, just like AxonHub. Today it
only knows about DeepSeek V4 for xhigh/max:

```ts
const OPENROUTER_DEEPSEEK_V4_THINKING_LEVEL_IDS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

export function supportsOpenRouterXHighThinking(modelId: string): boolean {
  return isOpenRouterDeepSeekV4ModelId(modelId);
}
```

The matcher uses OpenRouter's upstream routing prefix:

```ts
// extensions/openrouter/models.ts
export function isOpenRouterDeepSeekV4ModelId(modelId: unknown): boolean {
  const normalized = normalizeOpenRouterModelId(modelId);
  if (!normalized?.startsWith("deepseek/")) return false;
  const deepSeekModelId = normalized.slice("deepseek/".length).split(":", 1)[0];
  return deepSeekModelId === "deepseek-v4-flash" || deepSeekModelId === "deepseek-v4-pro";
}
```

OpenRouter plugin **also does not set `compat.supportedReasoningEfforts`**.

### 1.5 Vercel AI Gateway — `extensions/vercel-ai-gateway/thinking.ts`

Same pattern as OpenRouter, but with broader OpenAI coverage:

```ts
const VERCEL_OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro",
  "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex",
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex",
] as const;

export function resolveVercelAiGatewayThinkingProfile(modelId): ProviderThinkingProfile | undefined {
  const openAiModelId = stripTrustedUpstreamPrefix(modelId, "openai/");
  if (openAiModelId) return resolveOpenAiThinkingProfile(openAiModelId);

  const anthropicModelId = stripTrustedUpstreamPrefix(modelId, "anthropic/");
  if (anthropicModelId) {
    const profile = resolveClaudeThinkingProfile(anthropicModelId);
    return hasVercelSpecificClaudeProfile(profile) ? profile : undefined;
  }
  return undefined;
}
```

Note: it uses `resolveClaudeThinkingProfile` from
`plugin-sdk/provider-model-shared.ts` for Anthropic — see §2 below.

### 1.6 Anthropic — shared SDK helper

`plugin-sdk/provider-model-shared.ts` exports a reusable
`resolveClaudeThinkingProfile`:

```ts
const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"];
const CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES = [
  "claude-opus-4-6", "claude-opus-4.6",
  "claude-sonnet-4-6", "claude-sonnet-4.6",
];

export function resolveClaudeThinkingProfile(modelId: string): ProviderThinkingProfile {
  if (isClaudeOpus47ModelId(modelId)) {
    return {
      levels: [...BASE, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (isClaudeAdaptiveThinkingDefaultModelId(modelId)) {
    return {
      levels: [...BASE, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE };
}
```

This is the canonical reusable helper for Claude families. AxonHub can call
it directly when proxying Anthropic-developer models.

## 2. The OpenClaw transport layer already auto-downgrades

`src/agents/openai-reasoning-effort.ts` is the OpenAI-compatible transport
arbiter. It runs **before requests leave OpenClaw**, regardless of which
provider plugin emitted the model.

### 2.1 `resolveOpenAISupportedReasoningEfforts` — built-in family registry

If `model.compat.supportedReasoningEfforts` is set, it wins. Otherwise:

```ts
const GPT_5_REASONING_EFFORTS = ["minimal", "low", "medium", "high"];
const GPT_51_REASONING_EFFORTS = ["none", "low", "medium", "high"];
const GPT_52_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const GPT_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const GPT_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"];
const GPT_5_PRO_REASONING_EFFORTS = ["high"];
const GPT_51_CODEX_MAX_REASONING_EFFORTS = ["none", "medium", "high", "xhigh"];
const GPT_51_CODEX_MINI_REASONING_EFFORTS = ["medium"];
const GENERIC_REASONING_EFFORTS = ["low", "medium", "high"];

// Family detection by id regex (provider-agnostic):
//   gpt-5.1-codex-mini       → CODEX_MINI
//   gpt-5.1-codex-max        → CODEX_MAX
//   /^gpt-5(?:\.\d+)?-codex/ → CODEX
//   gpt-5-pro                → 5_PRO
//   /^gpt-5\.[2-9]-pro/      → PRO
//   /^gpt-5\.[2-9]/          → 52   (includes xhigh)
//   /^gpt-5\.1/              → 51
//   /^gpt-5/                 → 5
//   else                     → GENERIC
```

**Crucially this matches by `model.id` regardless of `model.provider`.**
So an AxonHub-routed `gpt-5.5` (provider=`axonhub`, id=`gpt-5.5`) gets the
correct GPT_52 efforts (including xhigh) automatically — without the plugin
having to set anything.

### 2.2 `resolveOpenAIReasoningEffortForModel` — graceful downgrade

```ts
export function resolveOpenAIReasoningEffortForModel(params): OpenAIApiReasoningEffort | undefined {
  const supported = resolveOpenAISupportedReasoningEfforts(params.model);
  if (supported.includes(normalized)) return normalized;
  if (isDisabledReasoningEffort(...)) return undefined;
  if (requested === "minimal" && supported.includes("low")) return "low";
  if ((requested === "minimal" || requested === "low") && supported.includes("medium")) return "medium";
  if (requested === "xhigh" && supported.includes("high")) return "high";   // ← key downgrade
  return supported.find((effort) => effort !== "none");
}
```

So **`xhigh` requests on a model that doesn't support xhigh are silently
downgraded to `high`** at the OpenClaw boundary. No 400 reaches the
upstream. This changes the threat model significantly — over-exposing
xhigh in the UI is **safe** for OpenAI-compatible transport (which
AxonHub uses).

### 2.3 But `max` is different

`max` is not part of pi-ai's `ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh"`.
It's handled out-of-band by per-plugin `wrapStreamFn` payload patches (see
the existing AxonHub plugin's `createOpenAICompatibleMaxThinkingWrapper`
which mutates `payload.reasoning_effort = "max"` on outgoing requests).

If a plugin's wrapper injects `reasoning_effort: max` for a model whose
upstream doesn't accept `max`, the upstream returns 400. Therefore **`max`
exposure must remain gated** to known-supporting families.

## 3. What pattern fits AxonHub

Drawing the matrix:

| Plugin | Source of truth | What's filled |
|---|---|---|
| LM Studio | runtime API (per-model) | `compat.supportedReasoningEfforts` + map |
| Groq | hardcoded family table | `compat.supportedReasoningEfforts` + map |
| OpenAI | hardcoded id list | `resolveThinkingProfile` only |
| OpenRouter | hardcoded id pattern | `resolveThinkingProfile` only |
| Vercel | hardcoded id list, upstream-prefix-aware | `resolveThinkingProfile` only |
| **AxonHub** today | hardcoded prefix list | `resolveThinkingProfile` only |
| **AxonHub** target | declarative family table by `(owned_by, id)` from `/v1/models`, optional remote registry | both `compat.supportedReasoningEfforts` (for non-OpenAI families) and `resolveThinkingProfile` (UI) |

**Key adjustment to the previously-drafted PRD direction (which said "let
backend downgrade or always-emit"):**

- xhigh: **safe to expose on any reasoning model** because OpenClaw transport
  auto-downgrades `xhigh → high`. We don't need to gate xhigh per model
  unless we want to truthfully represent capability in the UI.
- max: **must remain gated** to known-supporting families to avoid
  upstream 400s from the wrapStreamFn payload patch.
- `compat.supportedReasoningEfforts`: only worth filling for models where
  OpenClaw's built-in family detection is wrong/missing. Specifically:
    - Anthropic models (claude-opus-4.7, claude-sonnet-4.7, claude-opus-4.6)
      that DO support xhigh — without compat, OpenClaw downgrades xhigh→high.
    - Google Gemini 3.x thinking models with xhigh.
    - DeepSeek V4 family.
    - Any other reasoning family AxonHub proxies that has known xhigh.

## 4. Refined implementation outline (replaces older PRD direction)

The plugin should:

1. Continue calling `/v1/models?include=...`, taking `id`, `name`, `owned_by`, `capabilities.reasoning`.
2. Maintain a small **family table** keyed by `(developerNormalized, idPattern)`:
   - Each entry yields `{ supportsXHigh: bool, supportsMax: bool, defaultEfforts?: string[] }`.
   - Entries:
     - openai gpt-5.x (catch-all): xhigh, max — **but actually not needed at compat layer**, OpenClaw built-in registry handles it. Only matters for `wrapStreamFn` max patch + `resolveThinkingProfile` UI.
     - openai o3*, o4-mini*: xhigh, max.
     - anthropic claude-opus-4.7 / sonnet-4.7: xhigh, max (use shared `resolveClaudeThinkingProfile`).
     - anthropic claude-opus-4.6 / sonnet-4.6: adaptive (no xhigh per shared helper).
     - deepseek-v4-*: xhigh, max (with the existing payload wrapper).
     - google gemini-3*: xhigh.
     - others: none (default reasoning levels apply).
3. **`resolveThinkingProfile` (UI):**
   - For non-reasoning models: null.
   - For reasoning models: base levels `[off, minimal, low, medium, high]` plus optional family extras.
   - Reuse `resolveClaudeThinkingProfile` from plugin-sdk shared helper for `owned_by === "anthropic"`.
4. **`compat.supportedReasoningEfforts` (transport):**
   - Only fill it when OpenClaw's built-in OpenAI registry would be wrong:
     - Anthropic: when family supports xhigh, set `["low","medium","high","xhigh"]` so transport doesn't downgrade.
     - DeepSeek V4: set `["low","medium","high","xhigh"]`.
     - Gemini: set `["low","medium","high","xhigh"]`.
   - Leave unset for openai-family ids (built-in registry handles them) and unknown reasoning models (auto-downgrade is safe).
5. **`wrapStreamFn` (max payload patch):**
   - Keep the existing wrapper but drive it from the family table — when family says supportsMax, inject `reasoning_effort: max`.
6. **Forward-compat:** if `/v1/models` ever returns `capabilities.reasoning_efforts: string[]`, prefer it over the table.
7. **Externalization (per task PRD):** the family table can later move to an external metadata source (Owner's planned data-collection project). For now embed in-plugin and ship updates via npm releases.

## 5. Tests to mirror

- LM Studio's `models.test.ts` for normalize + compat building. (run-time data path)
- Groq's tests for family-table compat. (closest pattern to what AxonHub will look like)
- OpenAI / OpenRouter test suites for thinking-profile boundary cases.
- Existing AxonHub `test/reasoning-profile.test.mjs` baselines must be preserved.
