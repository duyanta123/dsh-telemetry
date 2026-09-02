# dsh-telemetry 配置文档

dsh-telemetry 支持通过配置文件、CLI 参数和环境变量覆盖配置。本文档描述所有可配置项、默认值和语义。

## 配置文件

配置文件为 JSON 格式，通过 `--config <file>` 指定：

```bash
node bin/telemetry.mjs --config telemetry.json --summary
```

## 完整配置项

```json
{
  "enabled": true,
  "store": "jsonl",
  "path": "~/.dsh/telemetry",
  "sample_rate": 1,
  "errors_always_sample": true,
  "slow_request_ms": 10000,
  "capture_metadata": "none",
  "hash_names": false,
  "retention_days": 7,
  "max_file_mb": 100,
  "flush_interval_ms": 1000,
  "batch_size": 100,
  "max_queue_events": 1000,
  "price_catalog": null,
  "redact_rules": []
}
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | true | 是否启用遥测（关闭后不记录事件，不创建日志文件） |
| `store` | string | jsonl | 存储后端：`jsonl` 或 `sqlite`（sqlite 需要 Node ≥22.5） |
| `path` | string | ~/.dsh/telemetry | 数据目录路径（支持 `~` 展开家目录） |
| `sample_rate` | number | 1 | 采样率（0..1），按 trace 整体决策 |
| `errors_always_sample` | boolean | true | 错误/取消事件是否绕过采样 |
| `slow_request_ms` | number | 10000 | 慢请求阈值（超过则保留） |
| `capture_metadata` | string | none | metadata 采集模式：`none`（不采集）或 `safe`（脱敏后采集） |
| `hash_names` | boolean | false | 是否哈希化工具/插件/模型名/profile |
| `retention_days` | number | 7 | 保留期（天数），超过此期限的数据会被清理 |
| `max_file_mb` | number | 100 | 单文件上限（MB），超过时轮转（JSONL）或清理最旧日期（SQLite） |
| `flush_interval_ms` | number | 1000 | 定时 flush 间隔（毫秒） |
| `batch_size` | number | 100 | 批量写入大小（事件数） |
| `max_queue_events` | number | 1000 | 队列上限（事件数），超过时丢弃新到事件 |
| `price_catalog` | string | null | 版本化价格目录 JSON 文件路径（用于成本计算） |
| `redact_rules` | array | [] | 自定义脱敏规则列表（见下方） |

## 自定义脱敏规则

每个规则对象包含 `name` 和 `pattern`（正则字符串）：

```json
{
  "redact_rules": [
    { "name": "employee_id", "pattern": "EMP-\\d+" },
    { "name": "internal_token", "pattern": "ITK_[A-Z0-9]{32}" }
  ]
}
```

规则在 metadata 字符串值上按序匹配，命中后替换为 `[redacted:<name>]`。

## 资源预算（计划 §7.2）

以下硬预算在代码中强制执行，配置值超出时会被钳制：

| 预算项 | 默认上限 | 说明 |
| --- | --- | --- |
| 单事件最大字节 | 64 KB | 超过的事件被丢弃并计数 |
| 队列最大事件数 | 1000 | 超过的新事件被丢弃并计数 |
| 最大批量大小 | 1000 | 超过时钳制到 1000 |
| 最小 flush 间隔 | 50 ms | 超过时钳制到 50 ms |

## 采样策略

- 决策粒度：按 `trace_id` 整体决策（同一 trace 的所有事件同命运）。
- 决策方法：`SHA256(salt + trace_id)` 取 hash，与 `sample_rate` 比较。
- 保留例外：`errors_always_sample=true` 时，失败/取消事件强制保留；慢请求强制保留。
- 元数据写入：保留的事件会写入 `sampling` 块（rate/strategy/errors_always_sample），便于解释聚合结果。

## 价格目录格式

用于成本计算，必须包含 `currency`、`effective_at` 和 `models` 映射：

```json
{
  "currency": "USD",
  "effective_at": "2026-08-23T00:00:00Z",
  "models": {
    "deepseek-chat": {
      "input_per_million": 0.27,
      "cached_input_per_million": 0.07,
      "output_per_million": 1.1
    }
  }
}
```

成本计算公式：

```
cost = (input_tokens / 1_000_000) * input_per_million
     + (cached_input_tokens / 1_000_000) * cached_input_per_million
     + (output_tokens / 1_000_000) * output_per_million
```

若模型名、usage 或价格缺失，`cost` 为 `null` 并在摘要中标记缺失原因。

## 环境变量

不通过环境变量配置敏感信息（密钥不属于遥测配置）。

## 配置解析失败行为

- 文件不存在/损坏 → 配置降级为 `{ enabled: false }`，并在 stderr 打印一次性警告。
- 字段类型错误 → 采用安全默认值（如 `sample_rate` 回退到 1），不猜测用户意图。
- 非法值（如 `store: "mongodb"`）→ 回退到 `jsonl`。

## 例子

### 仅保留错误和慢请求

```json
{
  "enabled": true,
  "sample_rate": 0.1,
  "errors_always_sample": true,
  "slow_request_ms": 5000,
  "capture_metadata": "safe"
}
```

### SQLite 后端 + 成本计算

```json
{
  "store": "sqlite",
  "path": "~/.dsh/telemetry/sqlite",
  "price_catalog": "~/.dsh/telemetry/prices.json"
}
```
