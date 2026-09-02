import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlStore, createSqliteStore, openStore, matchesFilters } from "../src/store.mjs";
import { isSqliteSupported } from "../src/sink-sqlite.mjs";
import { aggregateEvents } from "../src/aggregate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureData = join(root, "test", "fixtures", "telemetry-data");

// cpSync 递归复制在 Windows 非 ASCII 路径下触发 Node 崩溃（0xC0000409），改用逐条目复制
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(src, entry.name), join(dest, entry.name));
    else copyFileSync(join(src, entry.name), join(dest, entry.name));
  }
}

function copyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-store-"));
  const target = join(dir, "data");
  mkdirSync(target);
  copyDir(fixtureData, target);
  return target;
}

async function allEvents(store, filters) {
  const { events } = await store.readEvents(filters);
  return events;
}

test("store jsonl: reads all valid events, skips invalid and incompatible with counts", async () => {
  const store = createJsonlStore({ path: fixtureData });
  const { events, skipped } = await store.readEvents();
  assert.equal(events.length, 21);
  assert.equal(skipped.invalid, 1); // {invalid json line
  assert.equal(skipped.schema_incompatible, 1); // schema_version 2.0
  assert.equal(store.kind, "jsonl");
});

test("store jsonl: time window filters", async () => {
  const store = createJsonlStore({ path: fixtureData });
  const from = Date.parse("2026-08-23T12:04:00.000Z");
  const to = Date.parse("2026-08-23T12:06:00.000Z");
  const events = await allEvents(store, { fromMs: from, toMs: to });
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => Date.parse(e.timestamp) >= from && Date.parse(e.timestamp) <= to));
  assert.ok(events.every((e) => e.trace_id === "trace-002"));
});

test("store jsonl: dimension filters (profile/model/event prefix/errorsOnly/traceId)", async () => {
  const store = createJsonlStore({ path: fixtureData });

  const cliEvents = await allEvents(store, { profile: "cli" });
  assert.ok(cliEvents.every((e) => e.trace_id === "trace-003" || e.trace_id === undefined || e.session?.profile === "cli"));
  assert.ok(cliEvents.length > 0);

  const chatEvents = await allEvents(store, { model: "deepseek-chat" });
  assert.ok(chatEvents.every((e) => e.model?.name === "deepseek-chat"));
  assert.equal(chatEvents.length, 6);

  const modelDomain = await allEvents(store, { event: "model.*" });
  assert.ok(modelDomain.every((e) => e.event.startsWith("model.")));
  assert.equal(modelDomain.length, 8); // 3 requested + 1 first_token + 2 completed + 1 failed + 1 requested(t3)

  const failed = await allEvents(store, { errorsOnly: true });
  assert.equal(failed.length, 2); // model.failed + request.cancelled

  const trace = await allEvents(store, { traceId: "trace-001" });
  assert.equal(trace.length, 12);
});

test("store jsonl: status exposes files, bytes, counters", async () => {
  const store = createJsonlStore({ path: fixtureData });
  const status = await store.status();
  assert.equal(status.store, "jsonl");
  assert.equal(status.files.length, 1);
  assert.ok(status.total_bytes > 0);
  assert.equal(status.counters.written, 0); // fixture 无 meta.json
});

test("store jsonl: purge delegates to sink semantics", async () => {
  const dir = copyFixture();
  const oldFile = join(dir, "2026-07-01.jsonl");
  writeFileSync(oldFile, "{}\n", "utf8");
  const store = createJsonlStore({ path: dir });
  const result = await store.purge({ beforeMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(result.removed_files, 1);
});

test("store: openStore dispatches by kind", async () => {
  const jsonl = await openStore({ store: "jsonl", path: fixtureData });
  assert.equal(jsonl.kind, "jsonl");
  const sqlite = await openStore({ store: "sqlite", path: fixtureData });
  assert.equal(sqlite.kind, "sqlite");
});

test("matchesFilters: event wildcard and model tail matching", () => {
  const event = { event: "model.completed", timestamp: "2026-08-23T12:00:00.000Z", model: { name: "openai/deepseek-chat" } };
  assert.equal(matchesFilters(event, { event: "model.*" }), true);
  assert.equal(matchesFilters(event, { model: "deepseek-chat" }), true);
  assert.equal(matchesFilters(event, { model: "gpt" }), false);
});

// ---------- SQLite 读取与 JSONL 聚合一致性（Phase 5 验收） ----------

test("store sqlite: same events produce identical aggregation as jsonl", { skip: !(await isSqliteSupported()) && "node:sqlite unavailable" }, async () => {
  const { createSqliteSink } = await import("../src/sink-sqlite.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-parity-"));
  const sink = createSqliteSink({ dir, batchCount: 100, flushIntervalMs: 60000, maxQueue: 1000 });
  await sink.start();

  // 从 fixture 读事件写入 sqlite（跳过坏行）
  const jsonlStore = createJsonlStore({ path: fixtureData });
  const { events } = await jsonlStore.readEvents();
  for (const event of events) {
    const result = sink.write(event);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  await sink.flush();
  await sink.close();

  const sqliteStore = await createSqliteStore({ path: dir });
  const { events: fromSqlite } = await sqliteStore.readEvents();
  assert.equal(fromSqlite.length, events.length);

  const catalog = JSON.parse(await readFile(join(root, "test", "fixtures", "prices.json"), "utf8"));
  const a = aggregateEvents(events, { catalog });
  const b = aggregateEvents(fromSqlite, { catalog });
  assert.deepEqual(b.requests, a.requests);
  assert.deepEqual(b.tokens, a.tokens);
  assert.deepEqual(b.models, a.models);
  assert.deepEqual(b.tools, a.tools);
  assert.deepEqual(b.plugins, a.plugins);
  assert.deepEqual(b.cost, a.cost);

  const status = await sqliteStore.status();
  assert.equal(status.rows, events.length);
  assert.equal(status.store, "sqlite");

  // trace 过滤一致性
  const traceEvents = await allEvents(sqliteStore, { traceId: "trace-001" });
  assert.equal(traceEvents.length, 12);

  sqliteStore.close();
});

test("store sqlite: purge removes rows older than cutoff", { skip: !(await isSqliteSupported()) && "node:sqlite unavailable" }, async () => {
  const { createSqliteSink } = await import("../src/sink-sqlite.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-sqp-"));
  const sink = createSqliteSink({ dir, batchCount: 100, flushIntervalMs: 60000 });
  await sink.start();
  sink.write({
    schema_version: "1.0",
    event: "request.started",
    event_id: "e-old",
    trace_id: "t-old",
    span_id: "s-old",
    timestamp: "2026-07-01T00:00:00.000Z",
  });
  sink.write({
    schema_version: "1.0",
    event: "request.started",
    event_id: "e-new",
    trace_id: "t-new",
    span_id: "s-new",
    timestamp: "2026-08-23T00:00:00.000Z",
  });
  await sink.flush();
  await sink.close();

  const store = await createSqliteStore({ path: dir });
  const result = await store.purge({ beforeMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(result.removed_rows, 1);
  const { events } = await store.readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].trace_id, "t-new");
  store.close();
});
