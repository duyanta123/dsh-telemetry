#!/usr/bin/env node
/**
 * dsh-local-telemetry — 查询 CLI（计划 §10）。
 *
 *   node bin/telemetry.mjs --status
 *   node bin/telemetry.mjs --summary --since 24h --group-by model
 *   node bin/telemetry.mjs --trace <trace_id>
 *   node bin/telemetry.mjs --export report.json --since 7d
 *   node bin/telemetry.mjs --export TELEMETRY-REPORT.md --since 7d --format markdown
 *   node bin/telemetry.mjs --config telemetry.json --summary
 *   node bin/telemetry.mjs --purge --before 30d
 *   node bin/telemetry.mjs --ui --port 47610
 *
 * 全部命令只读本地存储（--purge 除外）；遥测查询不联网。
 */

import { writeFile } from "node:fs/promises";
import { resolveDataPath, sinceUntilRange, parseDurationOrTimestamp, loadConfigFile, resolveConfig } from "../src/config.mjs";
import { openStore } from "../src/store.mjs";
import { aggregateEvents, aggregateGrouped, slowTraceIds, buildTraceView } from "../src/aggregate.mjs";
import { loadPriceCatalog } from "../src/cost.mjs";
import { renderTextSummary, renderMarkdownReport, renderTraceText, renderGroupedText } from "../src/report.mjs";
import { createTelemetryServer } from "../src/server.mjs";

const USAGE = `dsh-local-telemetry — 本地 Harness 遥测查询 CLI（v0.1.2）

用法：
  node bin/telemetry.mjs --status
  node bin/telemetry.mjs --summary [--since 1h] [--until <t>] [--group-by model|plugin|tool|profile|day]
  node bin/telemetry.mjs --trace <trace_id>
  node bin/telemetry.mjs --export <file> [--since 7d] [--format text|json|markdown]
  node bin/telemetry.mjs --purge --before 30d
  node bin/telemetry.mjs --ui [--port 47610]

参数：
  --store jsonl|sqlite      存储后端（默认 jsonl；sqlite 需 Node ≥22.5）
  --path <dir>              数据目录（默认 ~/.dsh/telemetry）
  --config <file>           配置文件（解析失败时按「关闭」安全默认）
  --since <duration|ts>     时间窗起点（如 1h / 7d / ISO 时间戳）
  --until <duration|ts>     时间窗终点
  --profile <name>          按 profile 过滤
  --model <name>            按模型过滤
  --plugin <name>           按插件过滤
  --event <name|prefix.*>   按事件过滤（如 model.*）
  --group-by <key>          分组：model | plugin | tool | profile | day
  --format text|json|markdown  输出格式（默认 text；--export 未指定时按扩展名 .json/.md 推断）
  --errors-only             只看错误与取消
  --slow-over-ms <N>        只看耗时 ≥ N 的请求
  --sample-rate <0..1>      采样率（录制侧配置，查询命令接受但仅用于配置覆盖）
  --capture-metadata none|safe  metadata 采集（录制侧配置，同上）
  --json                    等价于 --format json
  --help                    本帮助

说明：所有摘要标注时间范围、样本数与分位数方法（nearest-rank）；成本为估算值。
`;

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const takesValue = !["status", "summary", "purge", "ui", "errors-only", "json", "help"].includes(key);
      if (takesValue && next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function fail(message, code = 2) {
  console.error(`dsh-local-telemetry: ${message}`);
  process.exit(code);
}

/** --json 显式优先；其次 --format；--export 时按目标扩展名推断（.json→json，.md→markdown）；默认 text。 */
function resolveFormat(flags) {
  if (flags.get("json")) return "json";
  const explicit = flags.get("format");
  if (explicit) return String(explicit);
  const exportTarget = flags.get("export");
  if (typeof exportTarget === "string") {
    if (exportTarget.endsWith(".json")) return "json";
    if (exportTarget.endsWith(".md")) return "markdown";
  }
  return "text";
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.get("help") || (flags.size === 0 && positional.length === 0)) {
    process.stdout.write(USAGE);
    process.exit(flags.get("help") ? 0 : 2);
  }

  // ---- 配置：文件 + CLI 覆盖 ----
  let fileConfig = undefined;
  if (flags.get("config")) {
    const loaded = loadConfigFile(String(flags.get("config")));
    fileConfig = loaded.config;
    if (!loaded.ok) {
      for (const error of loaded.errors) console.error(`[config] ${error}`);
    }
  }
  const overrides = {};
  if (flags.get("store")) overrides.store = String(flags.get("store"));
  if (flags.get("path")) overrides.path = String(flags.get("path"));
  if (flags.get("sample-rate")) overrides.sample_rate = Number(flags.get("sample-rate"));
  if (flags.get("capture-metadata")) overrides.capture_metadata = String(flags.get("capture-metadata"));
  const resolution = resolveConfig({ file: fileConfig, overrides });
  if (!resolution.ok) {
    for (const error of resolution.errors) console.error(`[config] ${error}`);
  }
  const config = resolution.config;
  const format = resolveFormat(flags);
  const dataPath = flags.get("path") ? resolveDataPath(String(flags.get("path"))) : resolveDataPath(config.path);

  if (flags.get("store") === "sqlite" && config.store === "sqlite") {
    const { isSqliteSupported } = await import("../src/sink-sqlite.mjs");
    if (!(await isSqliteSupported())) {
      fail("sqlite backend requires Node >= 22.5 (node:sqlite); use --store jsonl on this runtime", 1);
    }
  }

  const store = await openStore({ store: config.store, path: dataPath });

  // ---- --status ----
  if (flags.get("status")) {
    const status = await store.status();
    if (typeof store.close === "function") store.close();
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      const lines = [
        `Store: ${status.store}`,
        `Path:  ${status.path}`,
        status.unavailable ? `Note:  ${status.unavailable}` : null,
        `Files: ${status.files.length} (${status.total_bytes} bytes)${status.rows !== undefined ? `, rows: ${status.rows}` : ""}`,
        `Counters: written=${status.counters.written} dropped(write=${status.counters.dropped_write} queue=${status.counters.dropped_queue} oversize=${status.counters.dropped_oversize} invalid=${status.counters.dropped_invalid}) sampled_out=${status.counters.sampled_out}`,
      ].filter(Boolean);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return;
  }

  // ---- --purge --before <duration> ----
  if (flags.get("purge")) {
    const before = flags.get("before");
    if (!before || before === true) fail("--purge requires --before <duration> (e.g. 30d)");
    const parsed = parseDurationOrTimestamp(String(before));
    if (!parsed) fail(`invalid --before value: ${before}`);
    const cutoffMs = parsed.relative ? Date.now() - parsed.absolute : parsed.absolute;
    const result = await store.purge({ beforeMs: cutoffMs });
    if (typeof store.close === "function") store.close();
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Purged before ${new Date(cutoffMs).toISOString()}: removed_files=${result.removed_files} removed_bytes=${result.removed_bytes}${result.removed_rows !== undefined ? ` removed_rows=${result.removed_rows}` : ""}\n`
      );
    }
    return;
  }

  // ---- --ui ----
  if (flags.get("ui")) {
    const port = Number(flags.get("port") ?? 47610);
    let catalog = null;
    if (config.price_catalog) {
      const loaded = loadPriceCatalog(resolveDataPath(config.price_catalog));
      catalog = loaded.catalog;
    }
    const server = await createTelemetryServer({ store, catalog, catalogPath: config.price_catalog });
    await new Promise((resolveListen, rejectListen) => {
      server.listen(port, "127.0.0.1", resolveListen);
      server.on("error", rejectListen);
    });
    console.log(`dsh-local-telemetry UI: http://127.0.0.1:${port}/ (localhost only; Ctrl+C to stop)`);
    const shutdown = () => {
      server.close();
      if (typeof store.close === "function") store.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // ---- --summary ----
  if (flags.get("summary") || flags.get("export")) {
    const range = sinceUntilRange(flags.get("since") ?? null, flags.get("until") ?? null);
    const filters = {
      fromMs: range.from,
      toMs: range.to,
      profile: flags.get("profile") ? String(flags.get("profile")) : null,
      model: flags.get("model") ? String(flags.get("model")) : null,
      plugin: flags.get("plugin") ? String(flags.get("plugin")) : null,
      event: flags.get("event") ? String(flags.get("event")) : null,
      errorsOnly: Boolean(flags.get("errors-only")),
    };
    const { events, skipped } = await store.readEvents(filters);
    let effective = events;
    if (flags.get("slow-over-ms")) {
      const threshold = Number(flags.get("slow-over-ms"));
      if (!Number.isFinite(threshold) || threshold < 0) fail("invalid --slow-over-ms value");
      const ids = slowTraceIds(events, threshold);
      effective = events.filter((event) => ids.has(event.trace_id ?? event.span_id));
    }

    let catalog = null;
    let catalogPath = null;
    if (config.price_catalog) {
      catalogPath = resolveDataPath(config.price_catalog);
      const loaded = loadPriceCatalog(catalogPath);
      if (!loaded.ok && loaded.errors.length > 0) {
        for (const error of loaded.errors) console.error(`[price_catalog] ${error}`);
      }
      catalog = loaded.catalog;
    }

    const groupBy = flags.get("group-by") ? String(flags.get("group-by")) : null;
    const storeStatus = await store.status();
    const meta = {
      store: storeStatus.store,
      path: storeStatus.path,
      dropped: storeStatus.counters,
      priceCatalogPath: catalogPath,
      command: `node bin/telemetry.mjs ${process.argv.slice(2).join(" ")}`,
    };

    if (groupBy) {
      const rows = aggregateGrouped(effective, { groupBy, catalog, catalogPath });
      if (!rows) fail(`invalid --group-by value: ${groupBy} (expected model|plugin|tool|profile|day)`);
      const payload = { generated_at: new Date().toISOString(), group_by: groupBy, window: { since: flags.get("since") ?? null, until: flags.get("until") ?? null }, rows };
      await outputResult(payload, format, flags, () => renderGroupedText(rows, groupBy), meta, "summary");
      if (typeof store.close === "function") store.close();
      return;
    }

    const summary = aggregateEvents(effective, { catalog, catalogPath });
    summary.skipped = skipped;
    await outputResult(summary, format, flags, () => renderTextSummary(summary, { dropped: meta.dropped, store: meta.store }), meta, "summary");
    if (typeof store.close === "function") store.close();
    return;
  }

  // ---- --trace <id> ----
  if (flags.get("trace")) {
    const traceId = String(flags.get("trace"));
    const { events, skipped } = await store.readEvents({ traceId });
    if (events.length === 0) {
      console.error(`dsh-local-telemetry: no events found for trace ${traceId} (skipped: invalid=${skipped.invalid} schema=${skipped.schema_incompatible})`);
      process.exit(1);
    }
    const view = buildTraceView(events);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderTraceText(view)}\n`);
    }
    if (typeof store.close === "function") store.close();
    return;
  }

  fail("no command given (use --status | --summary | --trace <id> | --export <file> | --purge --before <d> | --ui)");
}

async function outputResult(payload, format, flags, renderText, meta, kind) {
  const exportTarget = flags.get("export");
  let body;
  if (format === "json") body = `${JSON.stringify(payload, null, 2)}\n`;
  else if (format === "markdown") body = `${renderMarkdownReport(payload, meta)}\n`;
  else body = `${renderText()}\n`;

  if (exportTarget && typeof exportTarget === "string") {
    const target = resolveDataPath(exportTarget);
    await writeFile(target, body, "utf8");
    console.error(`exported ${kind} to ${target} (format: ${format})`);
  } else {
    process.stdout.write(body);
  }
}

main().catch((error) => {
  console.error(`dsh-local-telemetry: ${error?.stack ?? error}`);
  process.exit(1);
});
