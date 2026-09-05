# Publishing

## 命名说明（重要）

- npm 包名：`dsh-local-telemetry`。`dsh-telemetry` 在 npm 上已被第三方（tudamu，2026-08-20 发布 0.0.1，同为 DeepSeek Harness 遥测方向）占用，故改名；已验证 `dsh-local-telemetry` 未注册。
- GitHub 仓库名保持 `dsh-telemetry`（小写，与 dsh-repo-scanner 惯例一致）。
- bin 命令：`telemetry` 与 `dsh-local-telemetry`；exports 子路径 `dsh-local-telemetry/telemetry`；cordis.patch.yml 插件行 id/name 均为 `dsh-local-telemetry`（manifest 契约测试强制与 package.json name 一致）。

## 发布前检查清单

1. 运行 `npm test`（128/128 全绿）与 `npm run check`（全模块语法检查），确保全部通过。
2. 运行 `npm pack --dry-run`，确认包含 `plugin/index.js`、`cordis.patch.yml`、`skills/`、`src/`、`bin/`、`web/`、`docs/`、`examples/`、`README.md`、`CHANGELOG.md`、`LICENSE`、`PUBLISHING.md`、`DSH-TELEMETRY-开发计划.md`。
3. 版本一致性：`package.json` version、`bin/telemetry.mjs` USAGE 版本号、`src/aggregate.mjs` `tool.version`、`CHANGELOG.md` 发布段、git tag 五处保持一致（manifest 契约测试覆盖前三处）。

## DSH bundle 契约（对齐 2026-09 现行契约）

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`——harness 只激活声明该字段的包。
- `cordis.patch.yml` 为 config-tree `- insert:` 补丁格式；harness 加载 `main`（`plugin/index.js`）。
- `plugin/index.js` 经官方 `@deepseek-ai/dsh-skill-filesystem` 的 `FileSystemSkillProvider` 注册 `skills/` 为技能根（includeDefaultRoots: false）。
- `skills/telemetry-runbook/SKILL.md` frontmatter 必填 `name`（kebab-case）+ `description`。
- 扫描内核经 exports 子路径 `dsh-local-telemetry/telemetry` 暴露；CLI bin 为 `telemetry` / `dsh-local-telemetry`。

## 发布渠道

### GitHub

1. push `main`，确认独立 JSONL/CLI 回归 CI 全绿（Node 18/20/22 × Windows/Ubuntu），并确认 Node 22.19 的 DSH compat job 通过。
2. 打 tag `v0.1.1` 并推送。
3. 给仓库添加 GitHub topic `dsh-plugin`（awesome 收录门槛之一）。

### npm

1. `npm login`（bugcome 账号）。
2. `npm publish`（首次发布非 scope 公有包无需 `--access public`；`prepublishOnly` 会先跑 `npm test`）。
3. 发布后核对 `npm view dsh-local-telemetry version` 与 dist-tags。

### awesome-dsh-plugin 收录（可选，参照 dsh-repo-scanner 经验）

- 仓库需创建满 1 天且 ≥10 个提交（自动检查，过滤一次性投稿仓；本仓历史提交偏少，可先补收尾提交再投）。
- 仓库 `package.json` 必须声明 `dsh.bundle`（根包或 packages/ 子包）。
- 需给仓库加 GitHub topic `dsh-plugin`。
- 检查失败后向同一分支推送修复即可，无需重开 PR。
