# Bug: deepseek-v4 模型 contextWindow/maxTokens 未写入配置

**发现时间**: 2026-04-28
**受影响版本**: @ruelya/axonhub-openclaw-plugin

## 现象

- `models.providers.axonhub.models` 在配置中为空数组 `[]`
- `agents.defaults.models` 中的 `axonhub/deepseek-v4-pro` 和 `axonhub/deepseek-v4-flash` 是空对象 `{}`
- 运行时走 `resolveDynamicModel` 返回 fallback 值 (contextWindow: 200K, maxTokens: 16K)

## 根因

AxonHub API 的 `/v1/models?include=...` 响应不返回 `context_length` 和 `max_output_tokens` 字段（所有模型均为 null）。

插件代码链：
1. `catalog.run` → `fetchAxonhubModels` → API 不返回 context_length → 本应 fallback 到 `AXONHUB_DEFAULT_CONTEXT_WINDOW` (200K)
2. catalog 返回的模型定义**未成功写入** `models.providers.axonhub.models`
3. `configure` wizard 将模型引用写进 `agents.defaults.models` 但内容为空

## 额外发现

Bug 同时在 AxonHub 后端：
- `GET /v1/models?include=...`（List 接口）**不返回** `context_length` / `max_output_tokens`
- `GET /v1/models/{id}?include=...`（Retrieve 接口）**正常返回**这两个字段

插件使用 List API 获取模型列表，数据缺失。Retrieve API 有值。

## 实际值（来自 Retrieve API）

| 模型 | context_length | max_output_tokens |
|------|---------------|-------------------|
| deepseek-v4-pro | 1,048,576 | 393,216 |
| deepseek-v4-flash | 1,048,576 | 393,216 |

## 涉及文件

- `index.ts`: `fetchAxonhubModels()`, `catalog.run`, `buildDynamicAxonhubModel()`
- `onboard.js`: `applyAxonhubConfig()` — 只写 baseUrl/apiKey，不写 models

## TODO

- 确认 catalog.run 的返回值为何未写入配置
- 确认是否需要让 applyAxonhubConfig 也处理 models 写入
- 排查 List API 不返回 context_length/max_output_tokens 的原因（后端返回 `data` 部分的字段缺失）
