# AxonHub backend reasoning capability surface (v0.9.38)

**Goal:** Ground-truth what the AxonHub backend (target deploy: **v0.9.38**,
commit `383ef932`) exposes for "which reasoning effort levels does each model
support". The plugin needs this to drive `resolveThinkingProfile` /
`supportsXHighThinking` and to populate per-model `compat.supportedReasoningEfforts`.

## TL;DR

1. AxonHub v0.9.38 **does not** expose any per-model reasoning-level / effort
   list in its `/v1/models[?include=...]` API. Capabilities are only
   `{vision, tool_call, reasoning}` — three booleans.
2. The backend **does not auto-degrade** unsupported xhigh/max efforts; it
   forwards the effort string to the upstream provider, which may 400.
3. **Auto-effort-suffix middleware** (`auto_reasoning_effort.go`) exists on
   `upstream/unstable` (commit `c4f89d95`, after v0.9.38) but is NOT in v0.9.38
   — so we cannot rely on `model-id-max` / `model-id-xhigh` suffix routing.
4. **OpenClaw already has the right shape** for this data:
   `ModelCompatConfig.supportedReasoningEfforts: string[]` per model.
   This field is consumed by `openai-reasoning-effort.ts` for transport-level
   effort filtering.
5. Live API verified at `http://localhost:8090` against the user's instance:
   23 models, all capabilities only have `{vision, tool_call, reasoning}`.

## 1. AxonHub v0.9.38 source-of-truth

Backend repo: `/home/ubuntu/.openclaw/workspace/axonhub-dev/backend`
checked out to tag `v0.9.38` = commit `383ef932 feat: deepseek anthropic adaptive thinking (#1505)`.

### 1.1 `/v1/models` response shape

`backend/internal/server/api/openai.go`:

```go
type Capabilities struct {
    Vision    bool `json:"vision"`     // L308-312
    ToolCall  bool `json:"tool_call"`
    Reasoning bool `json:"reasoning"`
}

type OpenAIModel struct {                            // L323-336
    ID              string        `json:"id"`
    Object          string        `json:"object"`
    Created         int64         `json:"created"`
    OwnedBy         string        `json:"owned_by"`
    Name            string        `json:"name,omitempty"`
    Description     string        `json:"description,omitempty"`
    ContextLength   int           `json:"context_length,omitempty"`
    MaxOutputTokens int           `json:"max_output_tokens,omitempty"`
    Capabilities    *Capabilities `json:"capabilities,omitempty"`
    Pricing         *Pricing      `json:"pricing,omitempty"`
    Icon            string        `json:"icon,omitempty"`
    Type            string        `json:"type,omitempty"`
}
```

`include=all` adds: `name, description, context_length, max_output_tokens, capabilities, pricing, icon, type` (extendedFields list, L370). **No reasoning-level field exists in any include path.**

### 1.2 Backend storage

`backend/internal/objects/model.go`:

```go
type ModelCardReasoning struct {
    Supported bool `json:"supported"`
    Default   bool `json:"default"`
}
```

The ent schema (`backend/internal/ent/schema/model.go`) stores `model_card`
as JSON; nothing else carries effort-level metadata.

### 1.3 Documented include behavior

`backend/docs/zh/api-reference/openai-api.md` L325-409:

> `capabilities` | 对象 | 模型能力（vision, tool_call, reasoning）

The docs explicitly enumerate three capability fields. No xhigh/max mention.

## 2. Live API verification (against user's instance)

Endpoint: `http://localhost:8090/v1/models?include=all`

Sample (truncated):

```json
{
  "id": "claude-opus-4-6",
  "owned_by": "anthropic",
  "name": "Claude Opus 4.6",
  "context_length": 200000,
  "max_output_tokens": 128000,
  "capabilities": {"vision": false, "tool_call": true, "reasoning": true},
  "pricing": {...},
  "type": "chat"
},
{
  "id": "gpt-5.5",
  "owned_by": "openai",
  "capabilities": {"vision": false, "tool_call": true, "reasoning": true},
  ...
},
{
  "id": "deepseek-v4-pro",
  "owned_by": "deepseek",
  "capabilities": {"vision": false, "tool_call": true, "reasoning": true},
  ...
}
```

23 models total. Every model entry has the **same capability shape** — three
booleans, no list. Confirmed empirically there is no hidden field.

Models seen on the instance (relevant ones for reasoning):
- openai: `gpt-5.5`, `gpt-5.3-codex`
- anthropic: `claude-opus-4-6`, `claude-sonnet-4-5-20250929`
- deepseek: `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-reasoner`,
  `deepseek-chat` (reasoning=false)
- google: `gemini-3-flash-preview`, `gemini-3.1-pro-preview`,
  `gemini-3.1-flash-lite-preview`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it`
- moonshot: `kimi-k2.5`, `kimi-k2.6`
- minimax: `MiniMax-M2.1`, `MiniMax-M2.7`
- zai: `glm-4.7`, `glm-4.6`, `glm-5`, `glm-5.1`

## 3. Backend behavior on unsupported effort values

- `backend/llm/transformer/openai/outbound_convert.go` L33: `ReasoningEffort: r.ReasoningEffort` — pass-through, no clamping.
- `backend/llm/transformer/openai/responses/outbound_convert.go` L460-484: passes through `effort` string verbatim.
- `backend/llm/transformer/anthropic/inbound_convert.go` L335-341: maps Anthropic `output_config.effort=max` → `chatReq.ReasoningEffort = "xhigh"`. Then anthropic outbound uses budget tokens via lookup table.
- `backend/llm/transformer/gemini/convert.go` L397-402: budget map `{low:1024, medium:8192, high:32768, xhigh:32768}`. No `max`. Falls through to default if unknown.

**Net effect: AxonHub v0.9.38 does NOT silently downgrade `xhigh`/`max` for
models/providers that don't accept them.** The OpenAI Chat Completions API
rejects values outside `minimal|low|medium|high`, so sending `max` to a
chat-completion-only model upstream causes a 400. This rules out the
"enable xhigh/max for all models, let backend downgrade" workaround.

## 4. Where the data should live

OpenClaw's `ModelDefinitionConfig` (`openclaw/src/config/types.models.ts`)
already has the slot:

```ts
export type ModelDefinitionConfig = {
  ...
  compat?: ModelCompatConfig;
};
export type ModelCompatConfig = ... & {
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string,string>;
  ...
};
```

The plugin's catalog return (`ProviderCatalogResult` → `ModelProviderConfig` →
`models: ModelDefinitionConfig[]`) can carry `compat.supportedReasoningEfforts`
per model. OpenClaw's `openai-reasoning-effort.ts` already reads this and
filters efforts at request time. The plugin's `resolveThinkingProfile` hook
provides UI-side levels — both must be coherent.

## 5. Auto-effort-suffix middleware (NOT in v0.9.38)

Commit `c4f89d95 feat: auto reasoning effort with suffix (#1515)` adds
`backend/internal/server/orchestrator/auto_reasoning_effort.go`. This is a
system-setting-gated middleware that splits `<model>-<effort>` and sets
`llmRequest.ReasoningEffort`. **It does not exist on v0.9.38** (file path
absent, commit landed after v0.9.38 was tagged). Therefore plugin design
cannot assume it is available.

## 6. Cross-repo readiness for an extended capability

If we wanted AxonHub to expose `capabilities.reasoning_efforts: string[]`
in the future:
- Add field to `Capabilities` struct in `openai.go`.
- Extend `ModelCardReasoning` in `internal/objects/model.go` with
  `Efforts []string`.
- Seed `models.json` for known reasoning families.
- Surface in `/v1/models?include=capabilities` and `RetrieveModel`.

This is **out of scope of the plugin task** but the plugin should be
written so that, if such a field appears later, it can be consumed
preferentially over the heuristic fallback.

## 7. Conclusion / recommendation for the plugin fix

Given v0.9.38's constraints:

1. **Plugin owns the family→efforts mapping**, keyed by `(owned_by, id-pattern)`,
   driven by AxonHub's `/v1/models?include=...` payload.
2. The mapping is a small declarative table (one entry per upstream family),
   easy to extend in a release.
3. Plugin emits `compat.supportedReasoningEfforts` per model on the catalog
   path AND uses the same table from `resolveThinkingProfile` so UI and
   transport stay coherent.
4. Forward-compat hook: also read an optional `capabilities.reasoning_efforts`
   from the AxonHub response if it ever appears, and prefer it over the
   table.
5. Maintenance docs / changelog: bump plugin patch version when adding new
   families. No remote registry; updates land via npm release.
