# dsh-telemetry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c1d95)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/duyanta123/dsh-telemetry/actions/workflows/ci.yml/badge.svg)](https://github.com/duyanta123/dsh-telemetry/actions/workflows/ci.yml)
[![npm](https://img.shields.io/badge/npm-dsh--local--telemetry-blue)](https://www.npmjs.com/package/dsh-local-telemetry)
[![version](https://img.shields.io/badge/version-0.1.0-green)](CHANGELOG.md)

本地优先的 Harness 运行遥测插件：记录请求、模型、工具与插件生命周期指标（延迟、Token、成本、错误、缓存），默认不采集内容。

> npm 包名为 `dsh-local-telemetry`（`dsh-telemetry` 在 npm 上已被第三方占用）；GitHub 仓库名保持 `dsh-telemetry`，两者指向同一项目。

## 定位

dsh-telemetry 是 Harness 运行可观测性插件，不负责业务分析，不负责修改请求内容，也不负责把用户对话上传到第三方平台。

它回答：
- 一次请求花了多少时间？
- 时间消耗在模型、工具、插件还是排队？
- 输入/输出 Token 和重试成本是多少？
- 哪些工具调用最慢、最容易失败？
- 哪些插件发生异常或阻塞？
- 缓存是否命中，模型路由是否节省了成本？
- 是否存在上下文过大、循环工具调用和异常重试？

一句话定位：

> Make Harness behavior measurable without collecting sensitive conversation content by default.

## 界面预览

**一屏总览**——请求、P95 延迟、首 Token 延迟、Token/缓存命中、估算成本（配置价格目录后自动计算）与错误分类，全部指标标注样本数，可由原始事件重算：

![仪表盘总览：KPI 卡片、Token 趋势与错误分类](docs/screenshots/dashboard.png)

**工具与插件耗时**——循环调用 ⚠ 提示、需用户确认的调用计数、插件 hook 错误统计；下方请求时间线以状态点区分成功/失败/取消，重试请求带 ↻ 标记：

![工具耗时、循环提示与插件 Hook 统计](docs/screenshots/tools-plugins.png)

**Trace 详情**——点击任意请求展开 span 树与事件时间线；下图展示 deepseek-reasoner 触发 rate_limit 后回退 deepseek-chat 成功的完整链路（每个 attempt 独立计时）：

![Trace 重试回退链详情](docs/screenshots/trace-fallback.png)

> 以上截图为本地只读 Web UI（`--ui`，仅绑定 127.0.0.1），数据为演示数据集；默认配置下不采集 prompt / response / 文件内容 / 密钥。

## 安装

作为 DSH 插件（推荐）：

```bash
dsh plugin --profile web add "github:duyanta123/dsh-telemetry#main"
```

或从 npm 安装（作为库或独立 CLI 使用）：

```bash
npm install dsh-local-telemetry
```

安装后重启 `dsh --profile web`，即可通过 `telemetry-runbook` 技能使用查询 CLI：

```bash
node bin/telemetry.mjs --status
node bin/telemetry.mjs --summary --since 24h
node bin/telemetry.mjs --trace <trace_id>
node bin/telemetry.mjs --ui --port 47610
```

## 快速开始

### 1. 作为宿主集成代码使用

事件经显式适配器接入（当前推荐的唯一方式）：

```js
import { createRecorder } from 'dsh-local-telemetry/telemetry';

const recorder = createRecorder({
  config: {
    path: '~/.dsh/telemetry',
    capture_metadata: 'safe', // 默认 none，不采集内容
    hash_names: false,
    sample_rate: 1,
    errors_always_sample: true,
    slow_request_ms: 10000,
    retention_days: 7,
  },
});
await recorder.start();

// 记录一条事件（缺失的 id 和 timestamp 会自动补全）
recorder.record({
  event: 'model.completed',
  trace_id: 'trace-001',
  span_id: 'span-003',
  parent_id: 'span-001',
  timestamp: '2026-08-23T12:00:00.000Z',
  model: { provider: 'deepseek', name: 'deepseek-chat', request_type: 'chat' },
  usage: { input_tokens: 4200, output_tokens: 860, cached_input_tokens: 0, reasoning_tokens: null },
  result: { status: 'success', finish_reason: 'stop' },
});

// 退出前 flush；失败不阻塞退出
await recorder.close();
```

### 2. 聚合读取（上层插件可引用）

```js
import { openStore, aggregateEvents, buildTraceView } from 'dsh-local-telemetry/telemetry';

const store = await openStore({ store: 'jsonl', path: '~/.dsh/telemetry' });
const { events } = await store.readEvents({ fromMs: Date.now() - 3600e3 });
const summary = aggregateEvents(events, { catalog: null });

console.log(`P95 latency: ${summary.requests.latency.p95}ms, Input tokens: ${summary.tokens.input}`);
```

### 3. 作为 DSH 技能调用（CLI 由技能指引）

```bash
node bin/telemetry.mjs --summary --since 1h --group-by model
node bin/telemetry.mjs --export TELEMETRY-REPORT.md --since 7d --format markdown
node bin/telemetry.mjs --purge --before 30d
node bin/telemetry.mjs --ui --port 47610
```

## CLI 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--store jsonl\|sqlite` | jsonl | 存储后端（sqlite 需 Node ≥22.5） |
| `--path <dir>` | ~/.dsh/telemetry | 数据目录 |
| `--config <file>` | - | 配置文件 |
| `--since <duration\|ts>` | - | 时间窗起点（如 1h / 7d / ISO 时间戳） |
| `--until <duration\|ts>` | - | 时间窗终点 |
| `--profile <name>` | - | 按 profile 过滤 |
| `--model <name>` | - | 按模型过滤 |
| `--plugin <name>` | - | 按插件过滤 |
| `--event <name\|prefix.*>` | - | 按事件过滤（如 model.*） |
| `--group-by <key>` | - | 分组：model\|plugin\|tool\|profile\|day |
| `--format text\|json\|markdown` | text | 输出格式（`--export` 未指定时按扩展名 `.json`/`.md` 推断） |
| `--errors-only` | - | 只看错误与取消 |
| `--slow-over-ms <N>` | - | 只看耗时 ≥ N 的请求 |
| `--sample-rate <0..1>` | - | 采样率（录制侧配置） |
| `--capture-metadata none\|safe` | - | metadata 采集（录制侧配置） |
| `--purge --before <d>` | - | 保留期清理 |

## 隐私与安全

- **默认不采集内容**：prompt、response、文件内容、命令参数、环境变量和密钥。
- **脱敏策略**：敏感字段（Authorization、Cookie、token、password、api_key 等）整键丢弃；URL 凭据与 query token 脱敏；绝对路径可配置为 basename 或哈希。
- **名称哈希**：工具、插件、模型名与 profile 可配置哈希化，稳定但不可直接还原。
- **本地存储**：默认 `~/.dsh/telemetry`（JSONL 按日期分文件，SQLite 可选），不联网。
- **只读 UI**：`--ui` 只绑定 127.0.0.1，禁止默认暴露到局域网。

## 版本规划

### v0.1.0

- 本地 JSONL + 可选 SQLite（Node ≥22.5 内置 `node:sqlite`）
- request/model/tool/plugin 基础事件
- 启停配置、fail-open、`--status`、`--summary`、`--trace`、`--export`、`--purge`、`--ui`
- 默认不采集内容
- 采样、慢请求、错误保留策略
- 成本目录、脱敏、隐私块、保留期清理
- Markdown 报告
- Trace/span 树与时间线视图

## 许可证

MIT
