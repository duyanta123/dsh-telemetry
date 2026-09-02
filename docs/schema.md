# dsh-telemetry 事件契约（schema version 1.0）

本文档定义 dsh-telemetry 事件的 JSON 结构、字段含义与使用约束。所有事件必须通过 `validateEvent` 校验，未知指标为 `null` 而非 0。

## 事件列表（计划 §2）

| 事件名 | 含义 |
| --- | --- |
| `request.started` | 用户请求开始（根 span） |
| `request.context` | 请求上下文（可选 metadata，仅 capture_metadata="safe" 时脱敏附加） |
| `model.requested` | 模型请求开始（attempt span） |
| `model.first_token` | 模型首 Token 到达 |
| `model.completed` | 模型请求成功完成 |
| `model.failed` | 模型请求失败 |
| `tool.started` | 工具调用开始 |
| `tool.completed` | 工具调用完成 |
| `plugin.started` | 插件 hook 开始 |
| `plugin.completed` | 插件 hook 完成 |
| `request.completed` | 用户请求成功完成 |
| `request.cancelled` | 用户请求被取消 |

**重要**：失败/超时/取消通过 `completed` 事件的 `result.status` 表达，无独立的 `tool.failed` 事件名。

## 最小事件结构

```json
{
  "schema_version": "1.0",
  "event": "model.completed",
  "event_id": "evt-001",
  "trace_id": "trace-001",
  "span_id": "span-003",
  "parent_id": "span-001",
  "timestamp": "2026-08-23T12:00:00.000Z",
  "duration_ms": 8420,
  "session": { "profile": "web", "environment": "local" },
  "model": {
    "provider": "deepseek",
    "name": "deepseek-chat",
    "request_type": "chat"
  },
  "usage": {
    "input_tokens": 4200,
    "output_tokens": 860,
    "cached_input_tokens": 0,
    "reasoning_tokens": null
  },
  "result": {
    "status": "success",
    "finish_reason": "stop"
  },
  "privacy": {
    "content_captured": false,
    "redactions": 0
  }
}
```

## 字段说明

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | string | 是 | 当前为 "1.0" |
| `event` | string | 是 | 事件名（必须为 12 种之一） |
| `event_id` | string | 是 | 事件唯一 ID（推荐 `evt-` + 12 hex） |
| `trace_id` | string | 是 | 请求追踪 ID（推荐 `trace-` + 12 hex） |
| `span_id` | string | 是 | 跨时间线的操作 ID（用于配对 started/completed） |
| `parent_id` | string | 否 | 父 span ID（构建树） |
| `request_id` | string | 否 | 用户请求 ID（可选，request 事件常用） |
| `timestamp` | string | 是 | ISO 8601 UTC（如 `2026-08-23T12:00:00.000Z`） |
| `duration_ms` | number | 否 | 毫秒整数（非负整数，未知则 null） |
| `session` | object | 否 | 请求会话信息 |
| `model` | object | 否 | 模型信息（model 事件） |
| `tool` | object | 否 | 工具信息（tool 事件） |
| `plugin` | object | 否 | 插件信息（plugin 事件） |
| `usage` | object | 否 | Token 使用量（model.completed 事件） |
| `result` | object | 否 | 结果状态（终止型事件） |
| `error` | object | 否 | 错误信息（失败/超时事件） |
| `sampling` | object | 否 | 采样元数据（写入事件，用于解释聚合结果） |
| `privacy` | object | 否 | 隐私元数据（content_captured/redactions/rules） |
| `metadata` | object | 否 | 可选脱敏后的安全元数据（仅 safe 模式） |

### session

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `profile` | string | Harness profile 名称（可配置哈希） |
| `environment` | string | 环境（如 local / prod） |

### model

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 提供商（如 deepseek / openai） |
| `name` | string | 模型名（如 deepseek-chat） |
| `request_type` | string | 请求类型（如 chat / completion） |

### tool

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 工具名 |

### plugin

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 插件名 |
| `hook` | string | Hook 名称（如 onRequest / onResponse） |

### usage

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `input_tokens` | number | 输入 Token 数（整数，无则为 null） |
| `output_tokens` | number | 输出 Token 数（整数，无则为 null） |
| `cached_input_tokens` | number | 缓存命中输入 Token 数（整数，无则为 null） |
| `reasoning_tokens` | number | 推理 Token 数（整数，无则为 null） |

### result

| 字段 | 类型 | 允许值 | 说明 |
| --- | --- | --- | --- |
| `status` | string | success / failed / timeout / cancelled | 操作结果 |
| `finish_reason` | string | - | 完成原因（仅 model.completed） |

### error

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | string | 错误分类（如 rate_limit / auth / network / server / invalid_request / timeout / unknown） |

### sampling

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rate` | number | 采样率（0..1） |
| `strategy` | string | 策略标识（per-trace-hash-v1） |
| `errors_always_sample` | boolean | 是否强制保留错误/取消 |

### privacy

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `content_captured` | boolean | 是否采集了内容字段（默认 false） |
| `redactions` | number | 脱敏命中次数 |
| `rules` | string[] | 命中的脱敏规则名列表 |

### metadata

- 仅当 `capture_metadata="safe"` 时附加。
- 脱敏后仅保留安全原语（数字/布尔/null/字符串）。
- 敏感键（Authorization/Cookie/token/password/secret/api_key 等）整键丢弃。
- 字符串值经过内置 + 自定义规则脱敏（URL 凭据、绝对路径、正则匹配）。

## 约束

- 时间戳必须为 ISO 8601 UTC（`YYYY-MM-DDThh:mm:ss.sssZ`）。
- `duration_ms` 为非负整数；未知时为 null（不补 0）。
- Token 字段为整数或 null；不可用 0 替代未知。
- 成本计算仅在 模型名 + usage + 价格目录 三者齐备时进行，否则 `cost: null` 并记录缺失原因。
- 采样按 trace 整体决策：同一 trace_id 的所有事件同决策，避免 trace 断裂。
- 默认不采集内容字段（prompt/response/文件正文/命令参数/环境变量/密钥）。
