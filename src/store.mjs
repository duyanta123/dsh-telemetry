/**
 * dsh-local-telemetry — 存储读取层（计划 §8）。
 *
 * JSONL 与 SQLite 共享同一读取接口与过滤语义；聚合器只面对事件数组，
 * 因此两种后端对同一事件集产生一致聚合结果（Phase 5 验收）。
 * 读取同样 fail-open：坏行 / 不兼容 schema 跳过并计数，绝不中断查询。
 */

import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_SCHEMA_MAJOR, deserializeEvent } from "./schema.mjs";
import { resolveDataPath } from "./config.mjs";
import { JsonlSink } from "./sink-jsonl.mjs";

const META_FILE = "meta.json";

export function normalizeFilters(filters = {}) {
  return {
    fromMs: filters.fromMs ?? null,
    toMs: filters.toMs ?? null,
    profile: filters.profile ?? null,
    model: filters.model ?? null, // 匹配 model.name 或其末段
    tool: filters.tool ?? null,
    plugin: filters.plugin ?? null,
    event: filters.event ?? null, // 精确事件名或 "request.*" 域通配
    traceId: filters.traceId ?? null,
    errorsOnly: Boolean(filters.errorsOnly),
  };
}

function modelMatches(modelObj, filterValue) {
  if (!filterValue) return true;
  const name = modelObj?.name;
  if (typeof name !== "string") return false;
  if (name === filterValue) return true;
  const tail = name.split("/").pop();
  return tail === filterValue;
}

function eventMatches(eventName, filterValue) {
  if (!filterValue) return true;
  if (filterValue.endsWith(".*")) return eventName?.startsWith(filterValue.slice(0, -1));
  return eventName === filterValue;
}

export function isFailureEvent(event) {
  const status = event.result?.status;
  return (
    event.event === "model.failed" ||
    event.event === "request.cancelled" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

/** 过滤器应用于单事件。 */
export function matchesFilters(event, filters) {
  const f = filters;
  if (f.fromMs !== null || f.toMs !== null) {
    const ts = Date.parse(event.timestamp ?? "");
    if (!Number.isFinite(ts)) return false;
    if (f.fromMs !== null && ts < f.fromMs) return false;
    if (f.toMs !== null && ts > f.toMs) return false;
  }
  if (f.profile && event.session?.profile !== f.profile) return false;
  if (!modelMatches(event.model, f.model)) return false;
  if (f.tool && event.tool?.name !== f.tool) return false;
  if (f.plugin && event.plugin?.name !== f.plugin) return false;
  if (f.event && !eventMatches(event.event, f.event)) return false;
  if (f.traceId && event.trace_id !== f.traceId) return false;
  if (f.errorsOnly && !isFailureEvent(event)) return false;
  return true;
}

/** JSONL 目录读取器。 */
export function createJsonlStore({ path, now = () => Date.now() } = {}) {
  const dir = resolveDataPath(path);
  return {
    kind: "jsonl",
    path: dir,
    async readEvents(filters = {}) {
      const f = normalizeFilters(filters);
      const events = [];
      const skipped = { invalid: 0, schema_incompatible: 0, unreadable_files: 0 };
      let names = [];
      try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
      } catch {
        return { events, skipped };
      }
      for (const name of names) {
        let content;
        try {
          content = await readFile(join(dir, name), "utf8");
        } catch {
          skipped.unreadable_files += 1;
          continue;
        }
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (line.length === 0) continue;
          const parsed = deserializeEvent(line);
          if (!parsed.ok) {
            skipped.invalid += 1;
            continue;
          }
          const event = parsed.event;
          const major = Number.parseInt(String(event?.schema_version ?? "").split(".")[0], 10);
          if (!Number.isFinite(major) || major !== SUPPORTED_SCHEMA_MAJOR) {
            skipped.schema_incompatible += 1;
            continue;
          }
          if (matchesFilters(event, f)) events.push(event);
        }
      }
      return { events, skipped };
    },

    async status() {
      let files = [];
      let totalBytes = 0;
      try {
        const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
        for (const name of names) {
          const info = await stat(join(dir, name));
          files.push({ name, bytes: info.size, mtime: info.mtimeMs });
          totalBytes += info.size;
        }
      } catch {
        files = [];
      }
      return {
        store: "jsonl",
        path: dir,
        exists: existsSync(dir),
        files,
        total_bytes: totalBytes,
        counters: await readMetaCounters(dir),
      };
    },

    async purge({ olderThanMs = null, beforeMs = null } = {}) {
      const sink = new JsonlSink({ dir });
      sink.now = now;
      return sink.purge({ olderThanMs, beforeMs });
    },
  };
}

/** SQLite 读取器（Node <22.5 时 available=false，readEvents 返回空集与原因）。 */
export async function createSqliteStore({ path } = {}) {
  const dir = resolveDataPath(path);
  const { sqliteAvailable } = await import("./sink-sqlite.mjs");
  const availability = await sqliteAvailable();
  if (!availability.available) {
    return {
      kind: "sqlite",
      path: dir,
      available: false,
      unavailable_reason: availability.reason,
      async readEvents() {
        return { events: [], skipped: { invalid: 0, schema_incompatible: 0, unreadable_files: 0 }, unavailable: availability.reason };
      },
      async status() {
        return { store: "sqlite", path: dir, exists: false, files: [], total_bytes: 0, rows: 0, counters: await readMetaCounters(dir), unavailable: availability.reason };
      },
      async purge() {
        return { removed_files: 0, removed_bytes: 0, removed_rows: 0, unavailable: availability.reason };
      },
    };
  }
  const { DatabaseSync } = availability.module;
  const dbPath = join(dir, "telemetry.sqlite3");
  let db = null;
  if (existsSync(dbPath)) {
    try {
      db = new DatabaseSync(dbPath);
    } catch {
      db = null;
    }
  }

  function requireDb() {
    if (!db) throw new Error("sqlite database not initialized");
    return db;
  }

  function buildWhere(f) {
    const clauses = [];
    const params = [];
    if (f.fromMs !== null) {
      clauses.push("ts >= ?");
      params.push(new Date(f.fromMs).toISOString());
    }
    if (f.toMs !== null) {
      clauses.push("ts <= ?");
      params.push(new Date(f.toMs).toISOString());
    }
    if (f.profile) {
      clauses.push("profile = ?");
      params.push(f.profile);
    }
    if (f.model) {
      clauses.push("(model_name = ? OR model_name = ?)");
      params.push(f.model, f.model.includes("/") ? f.model.split("/").pop() : f.model);
    }
    if (f.tool) {
      clauses.push("tool_name = ?");
      params.push(f.tool);
    }
    if (f.plugin) {
      clauses.push("plugin_name = ?");
      params.push(f.plugin);
    }
    if (f.event) {
      if (f.event.endsWith(".*")) {
        clauses.push("event LIKE ?");
        params.push(`${f.event.slice(0, -1)}%`);
      } else {
        clauses.push("event = ?");
        params.push(f.event);
      }
    }
    if (f.errorsOnly) {
      clauses.push("(event IN ('model.failed','request.cancelled') OR status IN ('failed','timeout','cancelled'))");
    }
    if (f.traceId) {
      clauses.push("trace_id = ?");
      params.push(f.traceId);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  function columnsFromRow(row) {
    const event = JSON.parse(row.data);
    // 列值以库内索引列为准回填缺失的冗余字段（JSON 与列不一致时以 JSON 为准）
    return event;
  }

  return {
    kind: "sqlite",
    path: dir,
    available: true,
    async readEvents(filters = {}) {
      const f = normalizeFilters(filters);
      const events = [];
      const skipped = { invalid: 0, schema_incompatible: 0, unreadable_files: 0 };
      if (!db) return { events, skipped };
      try {
        const { where, params } = buildWhere(f);
        const stmt = db.prepare(`SELECT data FROM events ${where} ORDER BY ts ASC`);
        for (const row of stmt.all(...params)) {
          try {
            events.push(columnsFromRow(row));
          } catch {
            skipped.invalid += 1;
          }
        }
      } catch {
        /* 查询失败按空集处理 */
      }
      return { events, skipped };
    },

    async status() {
      let bytes = 0;
      let rows = 0;
      try {
        bytes = (await stat(dbPath)).size;
      } catch {
        bytes = 0;
      }
      if (db) {
        try {
          rows = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
        } catch {
          rows = 0;
        }
      }
      return {
        store: "sqlite",
        path: dir,
        exists: existsSync(dbPath),
        files: existsSync(dbPath) ? [{ name: "telemetry.sqlite3", bytes }] : [],
        total_bytes: bytes,
        rows,
        counters: await readMetaCounters(dir),
      };
    },

    async purge({ olderThanMs = null, beforeMs = null } = {}) {
      const cutoff = beforeMs ?? (olderThanMs !== null ? Date.now() - olderThanMs : null);
      if (cutoff === null) throw new TypeError("purge requires olderThanMs or beforeMs");
      const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
      if (!db) return { removed_files: 0, removed_bytes: 0, removed_rows: 0 };
      try {
        const count = db.prepare("SELECT COUNT(*) AS n FROM events WHERE date < ?").get(cutoffDate).n;
        db.prepare("DELETE FROM events WHERE date < ?").run(cutoffDate);
        return { removed_files: 0, removed_bytes: 0, removed_rows: count };
      } catch {
        return { removed_files: 0, removed_bytes: 0, removed_rows: 0 };
      }
    },

    close() {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      db = null;
    },
  };
}

/** 按配置打开存储（读取侧）。 */
export async function openStore({ store = "jsonl", path } = {}) {
  if (store === "sqlite") return createSqliteStore({ path });
  return createJsonlStore({ path });
}

async function readMetaCounters(dir) {
  try {
    if (!existsSync(join(dir, META_FILE))) return emptyCounters();
    const meta = JSON.parse(await readFile(join(dir, META_FILE), "utf8"));
    return { ...emptyCounters(), ...(meta?.counters ?? {}) };
  } catch {
    return emptyCounters();
  }
}

function emptyCounters() {
  return { written: 0, dropped_queue: 0, dropped_oversize: 0, dropped_invalid: 0, dropped_write: 0, sampled_out: 0 };
}

/** 删除整个数据目录中的过期文件（JSONL）；SQLite 走其 purge。 */
export async function removeFile(path) {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}
