---
name: telemetry-runbook
description: 本地遥测查询与诊断：查询 Harness 请求、模型、工具、插件生命周期指标（延迟分位数、Token、估算成本、错误分类、重试与回退），查看 trace/span 树，导出 Markdown 报告，清理保留期数据，或启动本地只读 Web UI。需要分析请求耗时、Token 成本、工具失败或验证遥测采集状态时加载本技能。
---

# telemetry-runbook

dsh-telemetry runbook。遥测是旁路能力：查询只读本地存储，不联网；默认不采集 prompt / response / 文件内容 / 密钥。CLI 路径以仓库根为基准（插件安装后为 `<bundle-dir>/bin/telemetry.mjs`）。

## 调用方式

```bash
# 采集状态与累计计数（written / dropped / sampled_out）
node bin/telemetry.mjs --status
node bin/telemetry.mjs --status --json

# 摘要（默认窗口全量；百分比与分位数为 nearest-rank，可由原始事件重算）
node bin/telemetry.mjs --summary --since 1h
node bin/telemetry.mjs --summary --since 24h --group-by model       # model|plugin|tool|profile|day
node bin/telemetry.mjs --summary --errors-only --slow-over-ms 10000

# trace/span 树
node bin/telemetry.mjs --trace <trace_id>

# 导出（json 或 markdown；markdown 生成 TELEMETRY-REPORT.md 结构）
node bin/telemetry.mjs --export summary.json --since 7d
node bin/telemetry.mjs --export TELEMETRY-REPORT.md --since 7d --format markdown

# 保留期清理（删除 30 天前的日期文件/行）
node bin/telemetry.mjs --purge --before 30d

# 本地只读 Web UI（仅绑定 127.0.0.1，禁止暴露局域网）
node bin/telemetry.mjs --ui --port 47610

# 配置文件
node bin/telemetry.mjs --config telemetry.json --summary --since 24h
```

## 常用参数

- `--store jsonl|sqlite`：存储后端；sqlite 需要 Node ≥ 22.5（内置 node:sqlite），低版本会明确报错并建议回退 jsonl。
- `--path <dir>`：数据目录（默认 `~/.dsh/telemetry`；JSONL 按日期命名 `<YYYY-MM-DD>.jsonl`，超过 100MB 轮转 `.part-NNN`）。
- `--since / --until`：`500ms|10s|30m|1h|7d|30d` 或 ISO 时间戳。
- `--profile / --model / --plugin / --event <name|prefix.*>`：维度过滤。
- `--format text|json|markdown`；`--json` 等价 `--format json`。

## 库接口（宿主集成 / 上层插件）

宿主生命周期 Hook 尚未确认，事件经显式适配器接入：

```js
import { createRecorder, createEventBusAdapter } from 'dsh-telemetry/telemetry';

const recorder = createRecorder({ config: { path: '~/.dsh/telemetry', capture_metadata: 'safe' } });
await recorder.start();
recorder.record({
  event: 'model.completed',
  trace_id: 'trace-001', span_id: 'span-003', parent_id: 'span-001',
  timestamp: '2026-08-23T12:00:00.000Z',
  model: { provider: 'deepseek', name: 'deepseek-chat', request_type: 'chat' },
  usage: { input_tokens: 4200, output_tokens: 860, cached_input_tokens: 0, reasoning_tokens: null },
  result: { status: 'success', finish_reason: 'stop' },
});
await recorder.close(); // 退出前 flush；失败不阻塞
```

聚合读取（供 dsh-test-insight 等按 §15 边界通过公开聚合接口使用）：

```js
import { openStore, aggregateEvents, buildTraceView } from 'dsh-telemetry/telemetry';
const store = await openStore({ store: 'jsonl', path: '~/.dsh/telemetry' });
const { events } = await store.readEvents({ fromMs: Date.now() - 3600e3 });
const summary = aggregateEvents(events, { catalog: null });
```

## 事件契约要点

- 12 种生命周期事件（schema_version 1.0）；失败/超时用 completed 事件的 `result.status` 表达，无独立 `tool.failed` 事件名。
- 时长不在事件里臆造：聚合器按 `span_id` 配对 started/completed 推导；两端缺失则为 null。
- 未知指标为 null，不补 0；Token 只记录宿主/模型返回的真实 usage。
- 采样按 trace 整体决策（salted hash），错误/取消/慢请求默认绕过；`sampling` 块写入事件元数据。
- 成本仅在模型、usage、价格目录齐备时计算，否则 `cost: null` 并给出缺失原因。

## 解读提示

- 摘要样本数 n 与分位数方法随输出标注；窗口不同结果不可直接比较。
- `dropped` 计数为存储级累计值（write/queue/oversize/invalid/sampled），与时间窗口无关。
- 估算成本 ≠ 实际账单；价格目录版本与生效时间在摘要与 Markdown 报告附录中标注。
