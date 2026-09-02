/**
 * dsh-local-telemetry — 本地只读 Web UI 服务（计划 §9.3 / Phase 5）。
 *
 * 边界：
 * - 只读：仅 GET，数据经聚合接口输出，不暴露原始事件文件路径，不输出内容字段；
 * - 默认且仅绑定 127.0.0.1（禁止默认暴露到局域网）；
 * - 零依赖静态资源（web/），无外部 CDN 请求。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { aggregateEvents, aggregateGrouped, slowTraceIds, buildTraceView, listRequestRows } from "./aggregate.mjs";
import { sinceUntilRange } from "./config.mjs";
import { renderMarkdownReport } from "./report.mjs";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

/**
 * @param {object} opts
 * @param {object} opts.store openStore 结果（读取层）
 * @param {object|null} [opts.catalog] 价格目录
 * @param {string|null} [opts.catalogPath] 价格目录路径（来源标注）
 */
export function createTelemetryServer({ store, catalog = null, catalogPath = null } = {}) {
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
  server.setTimeout(15000);

  async function readJsonBody(url, query) {
    const filters = {
      fromMs: query.fromMs,
      toMs: query.toMs,
      profile: query.profile,
      model: query.model,
      plugin: query.plugin,
      event: query.event,
      errorsOnly: query.errors_only === "1" || query.errors_only === "true",
    };
    const { events, skipped } = await store.readEvents(filters);
    let effective = events;
    if (query.slow_over_ms) {
      const threshold = Number(query.slow_over_ms);
      if (Number.isFinite(threshold) && threshold >= 0) {
        const ids = slowTraceIds(events, threshold);
        effective = events.filter((event) => ids.has(event.trace_id ?? event.span_id));
      }
    }
    return { events: effective, skipped, filters };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "read-only interface" }));
      return;
    }

    const staticFile = STATIC_FILES[pathname];
    if (staticFile) {
      try {
        const body = await readFile(join(webDir, staticFile.file));
        res.writeHead(200, { "content-type": staticFile.type, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found (web assets missing)");
      }
      return;
    }

    const q = Object.fromEntries(url.searchParams.entries());
    const range = sinceUntilRange(q.since ?? null, q.until ?? null);

    if (pathname === "/api/status") {
      const status = await store.status();
      status.localhost_only = true;
      status.price_catalog = catalogPath ? { path: catalogPath, effective_at: catalog?.effective_at ?? null, currency: catalog?.currency ?? null } : null;
      json(res, status);
      return;
    }

    if (pathname === "/api/summary") {
      const { events, skipped } = await readJsonBody(url, { ...q, fromMs: range.from, toMs: range.to });
      const summary = aggregateEvents(events, { catalog, catalogPath });
      summary.skipped = skipped;
      const status = await store.status();
      summary.dropped = status.counters;
      json(res, summary);
      return;
    }

    if (pathname === "/api/grouped") {
      const by = q.by ?? "day";
      const { events } = await readJsonBody(url, { ...q, fromMs: range.from, toMs: range.to });
      const rows = aggregateGrouped(events, { groupBy: by, catalog, catalogPath });
      json(res, { group_by: by, rows: rows ?? [] });
      return;
    }

    if (pathname === "/api/requests") {
      const { events } = await readJsonBody(url, { ...q, fromMs: range.from, toMs: range.to });
      const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
      json(res, { requests: listRequestRows(events, { limit }) });
      return;
    }

    const traceMatch = pathname.match(/^\/api\/trace\/(.+)$/);
    if (traceMatch) {
      const traceId = decodeURIComponent(traceMatch[1]);
      const { events } = await store.readEvents({ traceId });
      if (events.length === 0) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "trace not found" }));
        return;
      }
      json(res, buildTraceView(events));
      return;
    }

    if (pathname === "/api/report.md") {
      const { events } = await readJsonBody(url, { ...q, fromMs: range.from, toMs: range.to });
      const summary = aggregateEvents(events, { catalog, catalogPath });
      const status = await store.status();
      const markdown = renderMarkdownReport(summary, {
        store: status.store,
        path: status.path,
        dropped: status.counters,
        command: "GET /api/report.md",
        priceCatalogPath: catalogPath,
      });
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(markdown);
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  function json(res, payload) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  return server;
}
