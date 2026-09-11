# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 约定。

## Unreleased

## 0.1.2 - 2026-09-11

- DSH 宿主兼容基线从 `0.1.2-rc.1` 迁移到 `0.1.5-rc.2`：`npm run test:compat` 与 CI compat job 固定安装 `@deepseek-ai/dsh@0.1.5-rc.2` + 同版本 `@deepseek-ai/dsh-skill-filesystem`。上游 0.1.3~0.1.5 的破坏性变更（`SessionHandle`、异步 `agentLoop.create()`、Session format v2/v3、`ctx.agent` 移除、Inbox API 变更）均不涉及本插件使用的技能 provider 路径，插件代码零改动。
- 提示：DSH 宿主升级到 0.1.5 系后 Session format 迁移为 V3，不可逆；最终用户升级宿主前请备份会话日志。

## 0.1.1 - 2026-09-06

- 新增固定 `@deepseek-ai/dsh@0.1.2-rc.1` 的 `npm run test:compat` 门禁及 Windows/Ubuntu Node 22.19 CI，覆盖隔离 profile 的 add、配置 dump 和有限时长启动。
- 文档明确三层兼容性：JSONL/纯 CLI Node >=18、SQLite Node >=22.5、最新 DSH 宿主验证 Node >=22.19。
- 修复插件入口遗漏 `skills` 服务注入声明的问题，确保 DSH 启动时实际注册 telemetry runbook，而不是静默降级。

## 0.1.0 - 2026-09-02

- 首个公开发布版本。

- 对齐 DSH bundle 契约（package.json `dsh.bundle.patch` + cordis.patch.yml `- insert:` 格式 + FileSystemSkillProvider 模式）。

- 完整 Phase 0-5 实现（JSONL/SQLite 双后端、CLI、Web UI、文档）。

### 核心

- 事件契约 schema\_version 1.0（12 种生命周期事件）。

- 本地 JSONL sink（队列/批量 flush/轮转/保留期/dropped 计数）。

- SQLite 可选后端（Node ≥22.5 内置 `node:sqlite`）。

- 显式事件总线适配器（当前唯一接入方式；宿主 Hook 尚未确认）。

- 记录器：ID 补全、名称哈希（可配置）、脱敏、按 trace 采样、fail-open。

### 聚合与查询

- 聚合器：请求/模型/工具/插件指标、nearest-rank 分位数、Token、成本。

- trace/span 树、时间线视图、请求列表。

- 过滤：时间窗、profile/model/plugin/event/errorsOnly/slow\_over\_ms。

- 分组：按 model/plugin/tool/profile/day。

### 隐私与安全

- 默认不采集 prompt/response/文件内容/密钥。

- 脱敏规则（内置 + 自定义正则）、URL 凭据处理、绝对路径策略。

- 名称哈希（SHA-256(salt+name) 截断 16 hex）。

- 本地存储、只读 UI（仅 127.0.0.1）、保留期清理。

### CLI

- `--status` / `--summary` / `--trace` / `--export` / `--purge` / `--ui`。

- `--group-by`、`--format text|json|markdown`；`--export` 未指定 `--format` 时按目标扩展名（`.json`/`.md`）推断输出格式。

- 配置文件支持（解析失败 → disabled 安全默认）。

### Web UI

- 暗色仪表盘（复刻 21st.dev Advanced Stats 设计语言）。

- KPI 卡片、Token/请求趋势图、错误分类、模型/工具/插件表格。

- 请求时间线、trace 树、Markdown 报告导出。

### 文档

- README（安装、快速开始、CLI 参数、隐私、版本规划）。

- docs/schema.md（事件契约、字段说明、示例）。

- docs/configuration.md（配置文件、环境变量、资源预算）。

- examples/telemetry.json、examples/prices.json（配置样例）。

### 测试

- schema/sink/recorder/aggregate/privacy/cli/server/manifest 全覆盖（127/127，本地 Windows 与 CI 全绿）。

- 测试基建规避 Node `fs.cpSync` 在 Windows 非 ASCII 路径下的进程崩溃（0xC0000409），改用逐条目复制。

- Phase 0 验收：缺失宿主能力不被伪造成可用指标。

- Phase 2 验收：摘要可由原始事件重算。

- Phase 5 验收：JSONL 与 SQLite 对同一事件集产生一致聚合结果。
