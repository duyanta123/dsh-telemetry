/**
 * dsh-local-telemetry — SQLite sink（计划 §8.2 / Phase 5，可选后端）。
 *
 * 零 npm 依赖：使用 Node ≥22.5 内置 node:sqlite（宿主已有 SQLite 能力路径）。
 * Node 18/20 下 sqliteAvailable() 返回不可用及原因，CLI/录制器优雅降级，
 * 绝不因此阻塞业务（fail-open）。
 *
 * 与 JSONL sink 共享同一事件 schema 与计数器语义；同一事件集上两者必须
 * 产出一致聚合结果（Phase 5 验收）。行存储完整 JSON（data 列）+ 查询列，
 * 全部使用参数化查询（§6.3）。大小上限的等价策略：超出后按最旧日期分批
 * 清理（SQLite 无文件轮转概念，行为写入文档）。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_EVENT_BYTES, serializeEvent, validateEvent } from "./schema.mjs";
import { utcDateOf } from "./sink-jsonl.mjs";

const DB_FILE = "telemetry.sqlite3";
const META_FILE = "meta.json";

let sqliteModuleCache = undefined;

/** 探测 node:sqlite 可用性（结果缓存）。 */
export async function sqliteAvailable() {
  if (sqliteModuleCache !== undefined) return sqliteModuleCache;
  try {
    const mod = await import("node:sqlite");
    sqliteModuleCache = { available: true, module: mod, reason: null };
  } catch (error) {
    sqliteModuleCache = { available: false, module: null, reason: `node:sqlite unavailable (${error.message})` };
  }
  return sqliteModuleCache;
}

export async function isSqliteSupported() {
  return (await sqliteAvailable()).available;
}

const COLUMNS = /** @type {const} */ ([
  "ts",
  "date",
  "event",
  "event_id",
  "trace_id",
  "span_id",
  "parent_id",
  "request_id",
  "profile",
  "provider",
  "model_name",
  "tool_name",
  "plugin_name",
  "status",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
]);

function extractColumns(event) {
  return {
    ts: event.timestamp,
    date: utcDateOf(event.timestamp),
    event: event.event,
    event_id: event.event_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_id: event.parent_id ?? null,
    request_id: event.request_id ?? null,
    profile: event.session?.profile ?? null,
    provider: event.model?.provider ?? null,
    model_name: event.model?.name ?? null,
    tool_name: event.tool?.name ?? null,
    plugin_name: event.plugin?.name ?? null,
    status: event.result?.status ?? (event.event === "model.failed" ? "failed" : event.event === "request.cancelled" ? "cancelled" : null),
    duration_ms: Number.isInteger(event.duration_ms) ? event.duration_ms : null,
    input_tokens: event.usage?.input_tokens ?? null,
    output_tokens: event.usage?.output_tokens ?? null,
    cached_input_tokens: event.usage?.cached_input_tokens ?? null,
  };
}

export function createSqliteSink({
  dir,
  maxFileBytes = 100 * 1024 * 1024,
  batchCount = 100,
  flushIntervalMs = 1000,
  maxQueue = 1000,
  retentionDays = 0,
  now = () => Date.now(),
} = {}) {
  if (!dir || typeof dir !== "string") throw new TypeError("createSqliteSink requires dir");
  const sink = {
    dir,
    maxFileBytes,
    batchCount: Math.max(1, Math.round(batchCount)),
    flushIntervalMs: Math.max(50, Math.round(flushIntervalMs)),
    maxQueue: Math.max(1, Math.round(maxQueue)),
    retentionDays,
    now,
    queue: [],
    counters: { written: 0, dropped_queue: 0, dropped_oversize: 0, dropped_invalid: 0, dropped_write: 0, sampled_out: 0 },
    lastWriteError: null,
    _db: null,
    _Database: null,
    _timer: null,
    _closed: false,
    _started: false,
    _metaDirty: false,
    _chain: Promise.resolve(),
  };

  async function start() {
    if (sink._started) return;
    sink._started = true;
    const availability = await sqliteAvailable();
    if (!availability.available) {
      sink.lastWriteError = availability.reason;
      return;
    }
    try {
      await mkdir(dir, { recursive: true });
      sink._Database = availability.module.DatabaseSync;
      sink._db = new sink._Database(join(dir, DB_FILE));
      sink._db.exec("PRAGMA journal_mode = WAL;");
      sink._db.exec("PRAGMA synchronous = NORMAL;");
      sink._db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          date TEXT NOT NULL,
          event TEXT NOT NULL,
          event_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_id TEXT,
          request_id TEXT,
          profile TEXT,
          provider TEXT,
          model_name TEXT,
          tool_name TEXT,
          plugin_name TEXT,
          status TEXT,
          duration_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_input_tokens INTEGER,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
        CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
        CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
      `);
      await loadMeta();
      sink._timer = setInterval(() => {
        void flush();
      }, sink.flushIntervalMs);
      if (typeof sink._timer.unref === "function") sink._timer.unref();
      if (sink.retentionDays > 0) {
        void purge({ olderThanMs: sink.retentionDays * 86_400_000 }).catch(() => {});
      }
    } catch (error) {
      sink.lastWriteError = String(error?.message ?? error);
      try {
        sink._db?.close();
      } catch {
        /* ignore */
      }
      sink._db = null;
    }
  }

  function write(event) {
    if (sink._closed) return { ok: false, reason: "sink_closed" };
    if (!sink._db) return { ok: false, reason: "sqlite_unavailable", detail: sink.lastWriteError };
    const check = validateEvent(event);
    if (!check.ok) {
      sink.counters.dropped_invalid += 1;
      sink._metaDirty = true;
      return { ok: false, reason: "invalid_event", errors: check.errors };
    }
    let payload;
    try {
      payload = serializeEvent(event);
    } catch {
      sink.counters.dropped_invalid += 1;
      sink._metaDirty = true;
      return { ok: false, reason: "invalid_event" };
    }
    if (Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) {
      sink.counters.dropped_oversize += 1;
      sink._metaDirty = true;
      return { ok: false, reason: "oversize" };
    }
    if (sink.queue.length >= sink.maxQueue) {
      sink.counters.dropped_queue += 1;
      sink._metaDirty = true;
      return { ok: false, reason: "queue_full" };
    }
    sink.queue.push({ payload, columns: extractColumns(event) });
    if (sink.queue.length >= sink.batchCount) void flush();
    return { ok: true };
  }

  function countDropped(kind) {
    if (kind === undefined || kind === null) return;
    const key = kind === "sampled_out" ? "sampled_out" : `dropped_${kind}`;
    if (key in sink.counters) {
      sink.counters[key] += 1;
      sink._metaDirty = true;
    }
  }

  async function flush() {
    if (sink._closed) return drainMeta();
    const batch = sink.queue.splice(0, sink.queue.length);
    if (batch.length > 0) {
      sink._chain = sink._chain.then(() => appendBatch(batch)).catch(() => {});
      await sink._chain;
    }
    await enforceSizeCap();
    return drainMeta();
  }

  function appendBatch(batch) {
    if (!sink._db) {
      sink.counters.dropped_write += batch.length;
      sink._metaDirty = true;
      return;
    }
    try {
      const insert = sink._db.prepare(
        `INSERT INTO events (${COLUMNS.join(",")}, data) VALUES (${COLUMNS.map(() => "?").join(",")}, ?)`
      );
      sink._db.exec("BEGIN");
      try {
        for (const item of batch) {
          const c = item.columns;
          insert.run(
            c.ts, c.date, c.event, c.event_id, c.trace_id, c.span_id, c.parent_id, c.request_id,
            c.profile, c.provider, c.model_name, c.tool_name, c.plugin_name, c.status,
            c.duration_ms, c.input_tokens, c.output_tokens, c.cached_input_tokens, item.payload
          );
        }
        sink._db.exec("COMMIT");
        sink.counters.written += batch.length;
      } catch (error) {
        try {
          sink._db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw error;
      }
    } catch (error) {
      sink.counters.dropped_write += batch.length;
      sink._metaDirty = true;
      sink.lastWriteError = String(error?.message ?? error);
    }
  }

  /** SQLite 的「轮转」等价物：超出大小上限时按最旧日期清理。 */
  async function enforceSizeCap() {
    if (!sink._db) return;
    try {
      const info = await stat(join(dir, DB_FILE));
      if (info.size <= sink.maxFileBytes) return;
      for (let i = 0; i < 200; i += 1) {
        const row = sink._db.prepare("SELECT MIN(date) AS d, COUNT(*) AS n FROM events").get();
        if (!row || row.d === null || row.n === 0) break;
        sink._db.prepare("DELETE FROM events WHERE date = ?").run(row.d);
        const after = await stat(join(dir, DB_FILE));
        if (after.size <= sink.maxFileBytes * 0.9) break;
      }
    } catch {
      /* 大小治理失败不影响主流程 */
    }
  }

  async function loadMeta() {
    try {
      if (!existsSync(join(dir, META_FILE))) return;
      const meta = JSON.parse(await readFile(join(dir, META_FILE), "utf8"));
      if (meta && typeof meta.counters === "object") {
        for (const [key, value] of Object.entries(meta.counters)) {
          if (key in sink.counters && Number.isInteger(value) && value >= 0) sink.counters[key] = value;
        }
      }
    } catch {
      /* 可接受 */
    }
  }

  async function drainMeta() {
    if (!sink._metaDirty) return;
    try {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, META_FILE),
        JSON.stringify({ version: 1, updated_at: new Date(sink.now()).toISOString(), counters: { ...sink.counters } }, null, 2),
        "utf8"
      );
      sink._metaDirty = false;
    } catch {
      /* ignore */
    }
  }

  async function status() {
    let bytes = 0;
    let rows = 0;
    try {
      bytes = (await stat(join(dir, DB_FILE))).size;
    } catch {
      bytes = 0;
    }
    if (sink._db) {
      try {
        rows = sink._db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
      } catch {
        rows = 0;
      }
    }
    return {
      store: "sqlite",
      dir,
      files: existsSync(join(dir, DB_FILE)) ? [{ name: DB_FILE, bytes }] : [],
      total_bytes: bytes,
      rows,
      counters: { ...sink.counters },
      last_write_error: sink.lastWriteError,
    };
  }

  async function purge({ olderThanMs = null, beforeMs = null } = {}) {
    const cutoff = beforeMs ?? (olderThanMs !== null ? sink.now() - olderThanMs : null);
    if (cutoff === null) throw new TypeError("purge requires olderThanMs or beforeMs");
    const cutoffDate = utcDateOf(new Date(cutoff).toISOString());
    if (!sink._db) return { removed_files: 0, removed_bytes: 0, removed_rows: 0 };
    try {
      const count = sink._db.prepare("SELECT COUNT(*) AS n FROM events WHERE date < ?").get(cutoffDate).n;
      sink._db.prepare("DELETE FROM events WHERE date < ?").run(cutoffDate);
      sink._metaDirty = true;
      await drainMeta();
      return { removed_files: 0, removed_bytes: 0, removed_rows: count };
    } catch (error) {
      sink.lastWriteError = String(error?.message ?? error);
      return { removed_files: 0, removed_bytes: 0, removed_rows: 0 };
    }
  }

  async function close() {
    if (sink._closed) return;
    if (sink._timer) {
      clearInterval(sink._timer);
      sink._timer = null;
    }
    try {
      await flush();
    } catch {
      /* ignore */
    }
    sink._closed = true;
    try {
      sink._db?.close();
    } catch {
      /* ignore */
    }
    sink._db = null;
    sink._metaDirty = true;
    try {
      await drainMeta();
    } catch {
      /* ignore */
    }
  }

  return { write, countDropped, flush, close, status, purge, start, get counters() { return sink.counters; } };
}
