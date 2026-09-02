import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSink } from "../src/sink-jsonl.mjs";
import { createSqliteSink, isSqliteSupported } from "../src/sink-sqlite.mjs";
import { newId, nowIsoUtc } from "../src/schema.mjs";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeEvent(i = 0, overrides = {}) {
  return {
    schema_version: "1.0",
    event: "request.completed",
    event_id: newId("event"),
    trace_id: `trace-${i}`,
    span_id: newId("span"),
    timestamp: nowIsoUtc(),
    duration_ms: 100,
    result: { status: "success" },
    ...overrides,
  };
}

test("sink: one complete JSON per line, batch flush drains queue", async () => {
  const dir = tmpDir("dsh-tel-sink-");
  const sink = new JsonlSink({ dir, batchCount: 10, flushIntervalMs: 50, maxQueue: 100 });
  await sink.start();
  for (let i = 0; i < 10; i += 1) sink.write(makeEvent(i));
  await sink.flush();
  await sink.close();
  const content = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))), "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 10);
  for (const line of lines) {
    const parsed = JSON.parse(line); // 任一半行 JSON 都会在此抛错
    assert.equal(parsed.schema_version, "1.0");
  }
  assert.equal(sink.counters.written, 10);
});

test("sink: write failure is fail-open — counted, never thrown, local warn throttled", async () => {
  const base = tmpDir("dsh-tel-fail-");
  const dir = join(base, "not-a-dir"); // 让 append 落到一个文件路径上 → 写失败
  writeFileSync(dir, "i am a file", "utf8");
  const sink = new JsonlSink({ dir: join(dir, "child"), batchCount: 2, flushIntervalMs: 50, maxQueue: 100 });
  await sink.start();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    const r1 = sink.write(makeEvent(1));
    assert.equal(r1.ok, true); // 入队成功
    await sink.flush();
    const r2 = sink.write(makeEvent(2));
    assert.equal(r2.ok, true); // 写失败不影响调用方
    await sink.flush();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(sink.counters.written, 0);
  assert.equal(sink.counters.dropped_write, 2);
  assert.ok(sink.lastWriteError);
  assert.equal(warns.filter((w) => w.includes("dsh-telemetry")).length, 1, "warn once until recovery");
  await sink.close();
});

test("sink: queue overflow drops newest with explicit counter", async () => {
  const dir = tmpDir("dsh-tel-queue-");
  const sink = new JsonlSink({ dir, batchCount: 1000, flushIntervalMs: 60000, maxQueue: 3 });
  await sink.start();
  for (let i = 0; i < 5; i += 1) {
    const result = sink.write(makeEvent(i));
    if (i >= 3) assert.equal(result.reason, "queue_full");
  }
  assert.equal(sink.counters.dropped_queue, 2);
  await sink.close(); // close 时 flush 剩余 3 条
  assert.equal(sink.counters.written, 3);
});

test("sink: oversize events dropped and counted (64KB budget)", async () => {
  const dir = tmpDir("dsh-tel-big-");
  const sink = new JsonlSink({ dir, maxQueue: 10 });
  await sink.start();
  const result = sink.write(makeEvent(1, { metadata: { blob: "x".repeat(80 * 1024) } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "oversize");
  assert.equal(sink.counters.dropped_oversize, 1);
  await sink.close();
});

test("sink: invalid events (schema/name) dropped and counted", async () => {
  const dir = tmpDir("dsh-tel-inv-");
  const sink = new JsonlSink({ dir });
  await sink.start();
  assert.equal(sink.write({ foo: "bar" }).reason, "invalid_event");
  assert.equal(sink.write(makeEvent(1, { event: "unknown.event" })).reason, "invalid_event");
  assert.equal(sink.counters.dropped_invalid, 2);
  await sink.close();
});

test("sink: rotation creates .part-NNN files when size cap exceeded", async () => {
  const dir = tmpDir("dsh-tel-rot-");
  const sink = new JsonlSink({ dir, maxFileBytes: 1024, batchCount: 1000, flushIntervalMs: 60000, maxQueue: 1000 });
  await sink.start();
  for (let i = 0; i < 40; i += 1) sink.write(makeEvent(i, { metadata: { pad: "y".repeat(120) } }));
  await sink.flush();
  await sink.close();
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  assert.ok(files.length >= 2, `expected rotation, got ${files.join(",")}`);
  assert.ok(files[0].endsWith(".jsonl"));
  assert.ok(files.some((f) => /\.part-\d{3}\.jsonl$/.test(f)), files.join(","));
});

test("sink: purge removes only files older than cutoff", async () => {
  const dir = tmpDir("dsh-tel-purge-");
  writeFileSync(join(dir, "2026-07-01.jsonl"), `{"old":true}\n`, "utf8");
  writeFileSync(join(dir, "2026-07-01.part-001.jsonl"), `{"old":true}\n`, "utf8");
  writeFileSync(join(dir, "2026-08-23.jsonl"), `{"new":true}\n`, "utf8");
  const sink = new JsonlSink({ dir });
  const result = await sink.purge({ beforeMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(result.removed_files, 2);
  assert.ok(existsSync(join(dir, "2026-08-23.jsonl")));
  assert.equal(existsSync(join(dir, "2026-07-01.jsonl")), false);
});

test("sink: counters persist to meta.json and survive restart", async () => {
  const dir = tmpDir("dsh-tel-meta-");
  const first = new JsonlSink({ dir });
  await first.start();
  first.countDropped("sampled_out");
  first.countDropped("sampled_out");
  first.write(makeEvent(1));
  await first.close();
  const second = new JsonlSink({ dir });
  await second.start();
  assert.equal(second.counters.sampled_out, 2);
  assert.ok(existsSync(join(dir, "meta.json")));
  await second.close();
});

test("sink: timed flush interval drains without explicit flush call", async () => {
  const dir = tmpDir("dsh-tel-timer-");
  const sink = new JsonlSink({ dir, batchCount: 1000, flushIntervalMs: 60, maxQueue: 100 });
  await sink.start();
  sink.write(makeEvent(1));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(sink.counters.written, 1);
  await sink.close();
});

test("sink: external dropped counting (sampled_out) reaches counters", async () => {
  const dir = tmpDir("dsh-tel-ext-");
  const sink = new JsonlSink({ dir });
  await sink.start();
  sink.countDropped("sampled_out");
  assert.equal(sink.counters.sampled_out, 1);
  await sink.close();
});

// ---------- SQLite sink（Node ≥22.5，否则跳过） ----------

const sqliteSupported = await isSqliteSupported();

test("sink sqlite: write/flush/roundtrip with same counters contract", { skip: !sqliteSupported && "node:sqlite unavailable on this runtime" }, async () => {
  const dir = tmpDir("dsh-tel-sq-");
  const sink = createSqliteSink({ dir, batchCount: 5, flushIntervalMs: 60000, maxQueue: 100 });
  await sink.start();
  for (let i = 0; i < 12; i += 1) {
    const result = sink.write(makeEvent(i));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  await sink.flush();
  assert.equal(sink.counters.written, 12);
  const status = await sink.status();
  assert.equal(status.store, "sqlite");
  assert.equal(status.rows, 12);
  await sink.close();
});

test("sink sqlite: unavailable sink fails open with explicit reason", { skip: !sqliteSupported && "node:sqlite unavailable on this runtime" }, async () => {
  const dir = tmpDir("dsh-tel-sq2-");
  const sink = createSqliteSink({ dir });
  // 不调用 start() → db 未初始化 → write 返回 sqlite_unavailable 而非抛错
  const result = sink.write(makeEvent(1));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sqlite_unavailable");
});

test("sink sqlite: queue overflow + oversize counters", { skip: !sqliteSupported && "node:sqlite unavailable on this runtime" }, async () => {
  const dir = tmpDir("dsh-tel-sq3-");
  const sink = createSqliteSink({ dir, maxQueue: 2, batchCount: 1000, flushIntervalMs: 60000 });
  await sink.start();
  for (let i = 0; i < 4; i += 1) sink.write(makeEvent(i));
  assert.equal(sink.counters.dropped_queue, 2);
  assert.equal(sink.write(makeEvent(9, { metadata: { blob: "z".repeat(80 * 1024) } })).reason, "oversize");
  await sink.close();
});
