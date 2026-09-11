# dsh-telemetry 维护规则（Maintenance Runbook）

> 本文档是 dsh-telemetry 仓库的专属维护基准，与工作区顶层 docs/PLUGIN-MAINTENANCE.md 通用规则配套使用（该文件位于本仓库之外）。本文件聚焦本仓库的细节。
> 原则：**不改不动，要改就一步到位**——代码/技能、测试、CHANGELOG、版本号、tag 一起改，不留下半成品版本。

## 1. 仓库概况

| 项 | 值 |
|---|---|
| 类型 | 运行遥测（JSONL / SQLite 双后端） |
| 当前版本 | 0.1.2 |
| 分发状态 | 正式项目（npm：`dsh-local-telemetry`；GitHub 仓库名 `dsh-telemetry`） |
| 运行时 | 零构建 ESM；SQLite 后端依赖 Node 内置 `node:sqlite`（>=22.5） |
| 核心模块 | `src/`（schema / recorder / sink / store / aggregate / report / server）+ `bin/telemetry.mjs` + `web/`（只读 UI） |

## 2. 目录结构与职责

```text
dsh-telemetry/
├── package.json              # npm 包 + dsh.bundle.patch + files 白名单
├── cordis.patch.yml          # DSH bundle patch（config-tree - insert: 格式）
├── plugin/index.js           # FileSystemSkillProvider 注册 skills/
├── skills/telemetry-runbook/SKILL.md   # 查询 CLI runbook
├── src/                      # 零依赖核心（正确性核心）
│   ├── schema.mjs            # 事件契约 schema version 1.0（validateEvent）
│   ├── config.mjs / privacy.mjs / sampling.mjs / cost.mjs
│   ├── sink-jsonl.mjs / sink-sqlite.mjs   # 双存储后端
│   ├── store.mjs / aggregate.mjs / report.mjs
│   ├── recorder.mjs / adapter.mjs          # 事件接入（显式适配器，当前唯一方式）
│   └── server.mjs            # 只读 Web UI（仅 127.0.0.1）
├── bin/telemetry.mjs         # CLI 入口（USAGE 内嵌版本号，发版必同步）
├── web/                      # 仪表盘前端资产
├── docs/                     # configuration.md / schema.md / screenshots/
├── examples/                 # telemetry.json / prices.json 配置样例
└── test/                     # schema/config/privacy/cost/sink/recorder/store/aggregate/cli/server/manifest + dsh-compat
```

## 3. CI 与测试门禁

- **独立回归**：`npm test`，当前 **128 例**，覆盖 schema / 配置 / 隐私 / 成本 / 双后端 / 聚合 / CLI / Web server / manifest 契约。
- **语法门禁**：`npm run check`（全模块 `node --check`）。
- **DSH 宿主兼容**：`npm run test:compat` 固定 `@deepseek-ai/dsh@0.1.5-rc.2`，要求 Node >=22.19，执行隔离 profile 的 add、dump-config 和有限时长启动。
- **GitHub Actions**：ubuntu + windows × Node 18/20/22 回归 + Node 22.19 compat job。
- **测试基建已知约束**：Node `fs.cpSync` 在 Windows 非 ASCII 路径下会进程崩溃（0xC0000409），测试复制逻辑采用逐条目复制，勿改回 `fs.cpSync`。

## 4. 一次完整变更的动作序列

1. 改代码 / 技能 / 文档
2. 补或更新 `test/` 对应用例（schema/隐私/成本/聚合等契约变化必须有断言）
3. 更新 `CHANGELOG.md`（先写 `Unreleased`）
4. 本地跑 `npm test`、`npm run check` 全绿
5. 有行为变更时改 `package.json` 的 `version`（semver）
6. 推送 `main`，GitHub Actions 全绿
7. 打 tag `v0.x.y` 并推送

## 5. 分场景维护细则

### 5.1 事件契约变更（`schema.mjs`）
- `schema_version` 是事件契约版本，独立于包版本演进；已发布事件字段不删除、语义不变更。
- 新增事件/字段必须同步：`docs/schema.md` 字段表、`validateEvent` 校验、schema 测试用例。

### 5.2 存储与聚合变更（`sink-*` / `store` / `aggregate`）
- JSONL 与 SQLite 必须对同一事件集产生一致聚合结果（Phase 5 验收线，改动后回归）。
- 摘要必须可由原始事件重算（Phase 2 验收线）；分位数标注样本数，未知指标为 `null` 而非 0。

### 5.3 隐私与脱敏变更（`privacy.mjs` / `sampling.mjs`）
- **高风险区**：任何放宽默认行为的改动（采集范围、脱敏规则、采样）都属于行为不兼容，需要显式版本号升级 + CHANGELOG 醒目提示。
- 隐私测试（`test/privacy.test.mjs`）是红线保障，改动必须先补用例。

### 5.4 CLI / Web UI 变更（`bin/telemetry.mjs` / `server.mjs` / `web/`）
- 新增 CLI 参数时同步三处：`bin/telemetry.mjs` USAGE、README 双语的「CLI 参数」表、`skills/telemetry-runbook/SKILL.md`。
- Web UI 保持只读 + 仅绑定 127.0.0.1，禁止引入任何写接口或对外绑定。

### 5.5 成本目录变更（`cost.mjs`）
- 价格目录缺失时成本记录为 null（带原因），不得补 0；成本三要素（输入/输出/缓存 Token）缺失同样按缺失记录。

### 5.6 元数据与打包
- 改动对外描述时同步：`README.md` / `README.zh-CN.md` 首段、`package.json` 的 `description`/`keywords`、awesome 列表条目。
- `files` 白名单已含 `plugin/`、`cordis.patch.yml`、`skills/`、`src/`、`bin/`、`web/`、`docs/`、`examples/`、双语 README、`CHANGELOG.md`、`PUBLISHING.md`、`LICENSE`、开发计划——新增顶层资产时记得核对。

## 6. 版本与发布节奏

- 多数改动为 **patch/minor**；事件契约或隐私默认行为不兼容时升 minor（0.x 阶段以 minor 代 major）。
- 版本号五处同步：`package.json`、`bin/telemetry.mjs` USAGE、`src/aggregate.mjs` `tool.version`、`CHANGELOG.md` 发布段、git tag。
- 发布动作详见 [PUBLISHING.md](PUBLISHING.md)。

## 7. 发布前清单

- [ ] `npm test` 全绿（128 例）
- [ ] `npm run check` 全过
- [ ] `npm run test:compat` 通过（DSH 0.1.5-rc.2 / Node 22.19+）
- [ ] `CHANGELOG.md` 已归并 `Unreleased`
- [ ] 版本号五处一致（package.json / bin USAGE / tool.version / CHANGELOG / tag）
- [ ] 双语 README 的 version 徽章已同步
- [ ] `files` 字段包含所有应发布文件
- [ ] 对外描述若变，列表条目已同步（或已提交 PR）
- [ ] 推送 `main`，GitHub Actions 全绿
- [ ] 打并推送 tag `v0.x.y`
