# Fix AxonHub plugin xhigh/max reasoning model detection and OpenClaw config

## Goal

修复 `@ruelya/axonhub-openclaw-plugin`：让插件能正确识别 AxonHub 实例上支持
xhigh/max 推理等级的模型，并把这些等级配置到 OpenClaw 的 thinking profile +
合适的 `compat.supportedReasoningEfforts`。

## Status

**🟡 Planning — 准备好了核心方向，等 owner 启动「外部模型元数据收集项目」后
落实数据源细节后即可进入 implement。**

## Research

- [`research/axonhub-backend-reasoning-capabilities.md`](research/axonhub-backend-reasoning-capabilities.md)
  — AxonHub v0.9.38 的 API surface 实测 + 后端处理 xhigh/max 的真实行为。
- [`research/openclaw-provider-plugin-patterns.md`](research/openclaw-provider-plugin-patterns.md)
  — 其他 OpenClaw provider 插件如何处理这一类问题；OpenClaw 自带的 transport-level
  自动降级逻辑。

## Key findings (从研究里提炼出来的会决定方案的事实)

1. **AxonHub `/v1/models` 不暴露粒度推理等级**——v0.9.38 实测只有
   `capabilities.{vision, tool_call, reasoning}` 三个 bool。
2. **OpenClaw transport 自带自动降级**——`src/agents/openai-reasoning-effort.ts`
   的 `resolveOpenAIReasoningEffortForModel` 在请求出 OpenClaw 之前就把
   `xhigh` 静默降为 `high`（如果模型不在 OpenClaw 内置 OpenAI family 注册表里）。
   **意味着插件给所有 reasoning 模型暴露 xhigh 是安全的，不会导致上游 400。**
3. **OpenClaw 内置 OpenAI family 注册表**已经按模型 id 正则识别 gpt-5.x / codex /
   pro / 5-pro / 5.1 等，不依赖 provider，所以 AxonHub 转发的 `gpt-5.5` 自动获得
   xhigh 支持。
4. **`max` 等级是 pi-ai 之外的扩展**——不在 `ThinkingLevel` 枚举里，由插件自己
   通过 `wrapStreamFn` 在 payload 里注入。OpenClaw 不会降级 max。
   **意味着 max 必须按家族 gate，否则不支持 max 的上游会 400。**
5. **OpenClaw 已有 `ModelDefinitionConfig.compat.supportedReasoningEfforts: string[]`**
   字段，是 transport 层「我家这个模型到底支持哪些 effort」的权威来源。LM Studio
   插件是它的最佳实践示例（fully data-driven）。Groq 是次佳（hardcoded family table）。
6. **plugin-sdk 已经导出了 `resolveClaudeThinkingProfile`**
   （`provider-model-shared.ts`），可以直接复用 Claude 家族（opus-4.6/4.7、sonnet-4.6/4.7）
   的等级判断，包括 xhigh / adaptive / max。

## Decision (ADR-lite)

**Context:** AxonHub 自己不暴露 per-model reasoning 等级；当前插件用硬编码前缀
判定，覆盖面窄。同行插件路径分两派——LM Studio 走 backend 数据驱动；OpenAI /
Groq / OpenRouter / Vercel 都走「家族 hardcoded 表」。

**Decision:** 走「**轻量家族表 + 复用 OpenClaw 内置降级 / Claude 共享 helper**」
的路线，预留外部数据源接入点。

具体形态：
- 插件维护一张小的 **family table**，key 是 `(developerNormalized, idPattern)`，
  value 是 `{ supportsXHigh, supportsMax, supportedEfforts? }`。
- `resolveThinkingProfile` 用这张表 + 共享 `resolveClaudeThinkingProfile`
  生成 UI 等级。
- 仅当 OpenClaw 内置 OpenAI family 注册表不覆盖（Anthropic、DeepSeek V4、
  Gemini-3 等）且家族确实支持 xhigh 时，才填 `compat.supportedReasoningEfforts`，
  避免被 OpenClaw 自动降级。
- `wrapStreamFn` 的 max payload patch 仍按 family table 中 `supportsMax = true`
  的家族 gate。
- 未知 reasoning 模型仍然暴露 `[off, minimal, low, medium, high, xhigh, max]`
  的等级（owner 倾向「能开就开」）；transport 层会安全降级 xhigh → high；max
  只在 family table 命中时通过 wrapStreamFn 注入，否则 wrapStreamFn 不发 max。
- 预留 forward-compat：未来如果 AxonHub `/v1/models` 加了
  `capabilities.reasoning_efforts: string[]`，插件优先消费它。
- 预留 external registry：当 owner 的数据收集项目落地后，把家族表的来源切到
  外部源 + 内置兜底；接入方式（HTTP/JSON/npm 子包）等数据源就绪后再定。

**Consequences:**
- ✅ 不需要后端改动即可即时改善覆盖面。
- ✅ 比当前硬编码前缀更灵活，能区分 OpenAI / Anthropic / Gemini / DeepSeek 家族。
- ✅ xhigh 暴露给所有 reasoning 模型不会导致 400（OpenClaw 自动降级兜底）。
- ✅ 复用 plugin-sdk 现成的 `resolveClaudeThinkingProfile`，少写 Claude 自己的代码。
- ⚠️ max 仍依赖家族表，新家族需要 plugin release 才会激活；待数据源就绪后能改善。
- ⚠️ 外部数据源协议未定，本期实现先用内置 family table。

## Requirements

### MVP (本任务交付)
- [ ] 用 `(owned_by, id-pattern)` 替代当前的全 id 前缀匹配，构建一张
      family table；至少覆盖：openai gpt-5.x / o3 / o4-mini，anthropic
      claude-opus-4.7 / sonnet-4.7（直接复用 `resolveClaudeThinkingProfile`），
      claude-opus-4.6 / sonnet-4.6（用共享 helper），deepseek-v4-flash /
      deepseek-v4-pro，google gemini-3.x。
- [ ] `resolveThinkingProfile` 通过 family table + 共享 helper 生成等级；
      非 reasoning 模型返回 null。
- [ ] catalog / augmentModelCatalog 在返回每个模型时，按 family table 决定
      是否填 `compat.supportedReasoningEfforts`（仅在需要覆盖 OpenClaw 默认时填）。
- [ ] `wrapStreamFn` 的 max payload patch 改用 family table 的 `supportsMax`。
- [ ] 保留所有现有测试断言（gpt-5.5 等系列、deepseek-v4-* 都仍然出现 xhigh/max）。
- [ ] 新增测试：claude-opus-4.7 出现 xhigh+max，gemini-3-flash 出现 xhigh，
      未知 reasoning 模型不出现 max。
- [ ] forward-compat hook：如果 `AxonhubModelEntry.capabilities` 上未来出现
      `reasoning_efforts` 数组（或类似字段），插件优先消费。

### 留给后续任务（external metadata source）
- [ ] 把 family table 来源从 in-plugin 改为外部 metadata 项目
      （owner 单独立项后定）。
- [ ] 增加缓存 / 刷新策略。
- [ ] 跨项目契约（schema、版本兼容）。

## Acceptance Criteria

- [ ] `npm run typecheck` / `validate:manifest` / `test:reasoning-profile` 全绿。
- [ ] 新增 unit test 覆盖 family table 的命中/未命中。
- [ ] 用 owner 本地实例（`http://localhost:8090`，`ah-4d84c306ee...`）跑过一次
      reachability test：列出 23 个模型，每个 reasoning 模型的等级符合预期。
- [ ] `gpt-5.5`/`gpt-5.3-codex` 等保留 xhigh+max；`claude-opus-4-6` 至少有
      adaptive；`claude-opus-4-7`（如果实例上有）有 xhigh+adaptive+max；
      `deepseek-v4-*` 保留 xhigh+max；非 reasoning 的 `deepseek-chat`/embedding
      模型不出现这些等级。
- [ ] 未知 reasoning 模型（比如 `MiniMax-M2.7`）暴露 xhigh，但不暴露 max
      （OpenClaw 自动把 xhigh 降级为 high；wrapStreamFn 不注入 max）。

## Definition of Done

- 单元 / 集成测试覆盖 family table 命中/未命中、Claude 共享 helper 集成、
  forward-compat 字段消费。
- typecheck / 现有 test 通过。
- README / changelog 更新（说明 supportedReasoningEfforts 行为变化、版本号
  bump）。
- 新版本发布。

## Out of Scope

- 修改 AxonHub 后端 API。
- 修改 OpenClaw 主仓的 thinking profile 解析逻辑。
- 实现外部数据源 fetch（等 owner 立项后的后续任务）。

## Open Items（需要在进入 implement 之前敲定）

1. external metadata 项目的形态（HTTP API? JSON 文件? npm 子包?）
   — owner 立项后回填。
2. family table 应不应该把不太确定的家族（GLM 5/5.1、Kimi K2.5/K2.6、MiniMax M2.x）
   纳入 `supportsMax`？建议先**不**纳入（max 由 wrapStreamFn 注入，错就 400），
   等 owner 的数据源能给出权威答案后再说；xhigh 由 OpenClaw 自动降级兜底，
   纳入与否影响很小。
3. 是否在 plugin 里再加一个 OpenClaw config schema 扩展，让用户能在
   `models.providers.axonhub.thinkingProfiles` 自定义额外家族？倾向 **不加**，
   保持插件简洁，等外部数据源到位后由数据源提供。

## Technical Notes

### 关键文件
- `index.ts` — 主逻辑，含 `supportsXHighThinkingModel`、`fetchAxonhubModels`、
  `buildAxonhubThinkingProfile`、`catalog.run`、`augmentModelCatalog`、
  `wrapStreamFn`。
- `test/reasoning-profile.test.mjs` — 推理 profile 锁定测试。
- `package.json` — 版本号（当前 1.0.6）。
- `provider-catalog.ts` — `resolveAxonhubModelCapabilities`（兜底单模型 capabilities）。

### OpenClaw 现成可复用的部件
- `openclaw/src/plugin-sdk/provider-model-shared.ts` —
  `resolveClaudeThinkingProfile`、`isClaudeOpus47ModelId`、
  `isClaudeAdaptiveThinkingDefaultModelId`、`matchesExactOrPrefix`。
- `openclaw/src/agents/openai-reasoning-effort.ts` — 内置 OpenAI family 注册表
  + 自动降级（不需要插件主动调用，transport 自动跑）。
- `openclaw/src/config/types.models.ts` — `ModelDefinitionConfig.compat.supportedReasoningEfforts`。

### 后端参考（v0.9.38）
- `backend/internal/server/api/openai.go` L308-336（Capabilities / OpenAIModel）
- `backend/internal/objects/model.go` L3-6（ModelCardReasoning）
- `backend/llm/transformer/anthropic/inbound.go` L92（接受 xhigh/max 的入站校验）
- `backend/llm/transformer/anthropic/inbound_convert.go` L335-341（max → xhigh 映射）
- `backend/llm/transformer/gemini/convert.go` L397-402（effort budget 表）

### 历史相关任务
- `.trellis/tasks/05-01-fix-axonhub-reasoning-levels-xhigh-max/`（已完成，加入 DeepSeek V4 + max wrapper）
- 最近 commit `b533aeb`（用 `gpt-5` 前缀兜底覆盖 GPT-5.5）
- 相邻 bug `bugs/context-window-missing.md`（List API context_length 缺失，本任务可顺手对齐）

### 测试基线（必须保留）
`test/reasoning-profile.test.mjs` 现有断言：
- `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`, `deepseek-v4-flash`,
  `deepseek-v4-pro`, `axonhub/deepseek-v4-pro` 都返回完整 7 个等级
  `[off, minimal, low, medium, high, xhigh, max]`。
- `ordinary-reasoning-model` 返回 5 个等级（无 xhigh/max）。
- `plain-chat` + `reasoning=false` 返回 null。
- `supportsXHighThinking({modelId: 'deepseek-v4-flash'})` = true。
- `supportsXHighThinking({modelId: 'plain-chat'})` = false。

注意：上面的「ordinary-reasoning-model」测试期望要决定怎么调和——按本任务方向，
任何 reasoning 模型都应该出 xhigh（OpenClaw 会兜底降级）。这个用例需要要么改成
明确「不在 family table 命中、不期望 xhigh」的实现，要么调整断言为带 xhigh
（与 owner 偏好「能开就开」一致）。implement 阶段确认。
