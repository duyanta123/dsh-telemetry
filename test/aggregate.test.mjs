import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeEvent } from "../src/schema.mjs";
import { loadPriceCatalog } from "../src/cost.mjs";
import {
  aggregateEvents,
  aggregateGrouped,
  pairSpans,
  slowTraceIds,
  buildTraceView,
  listRequestRows,
  percentile,
} from "../src/aggregate.mjs";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const testDir = join(dirname(fileURLToPath(import.meta.url)));

async function loadFixtureEvents() {
  const content = await readFile(join(fixtureDir, "telemetry-data", "2026-08-23.jsonl"), "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => deserializeEvent(line))
    .filter((parsed) => parsed.ok)
    .map((parsed) => parsed.event)
    .filter((event) => String(event.schema_version ?? "").startsWith("1."));
}

test("aggregate: percentile uses deterministic nearest-rank", () => {
  assert.equal(percentile([1, 2], 50), 1);
  assert.equal(percentile([1, 2], 95), 2);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([5], 99), 5);
  assert.equal(percentile([], 50), null);
});

test("aggregate: pairSpans matches by span_id, falls back to trace+name", () => {
  const pairs = pairSpans(
    [
      { event: "tool.started", trace_id: "t", span_id: "s1", timestamp: "2026-08-23T12:00:00.000Z", tool: { name: "a" } },
      { event: "tool.completed", trace_id: "t", span_id: "s1", timestamp: "2026-08-23T12:00:01.000Z", tool: { name: "a" } },
      { event: "tool.started", trace_id: "t", span_id: "s2", timestamp: "2026-08-23T12:00:02.000Z", tool: { name: "b" } },
      { event: "tool.completed", trace_id: "t", span_id: "other", timestamp: "2026-08-23T12:00:03.000Z", tool: { name: "b" } },
    ],
    { startedName: "tool.started", endNames: ["tool.completed"], nameOf: (e) => e.tool?.name }
  );
  assert.equal(pairs.pairs.length, 2);
  assert.equal(pairs.unmatched.length, 0);
  assert.equal(pairs.pairs[1].start.span_id, "s2"); // span 缺失时按 trace+name 兜底配对
});

test("aggregate: fixture summary is recomputable and complete", async () => {
  const events = await loadFixtureEvents();
  const catalog = loadPriceCatalog(join(testDir, "fixtures", "prices.json")).catalog;
  const summary = aggregateEvents(events, { catalog, catalogPath: "test/fixtures/prices.json" });

  // 请求级：3 个请求（2 成功 1 取消）
  assert.equal(summary.requests.total, 3);
  assert.equal(summary.requests.success, 2);
  assert.equal(summary.requests.cancelled, 1);
  assert.equal(summary.requests.failed, 0);
  assert.equal(summary.requests.success_rate, 0.6667);

  // 重试与回退：trace-002 reasoner 失败后回退 chat
  assert.equal(summary.requests.retries, 1);
  assert.equal(summary.requests.fallbacks, 1);

  // 延迟：durations [8100, 9100, 1000] → nearest-rank
  assert.deepEqual(summary.requests.latency, { p50: 8100, p95: 9100, p99: 9100, avg: 6067, n: 3 });
  // 排队：[500, 200, 300] → p50 300, p95 500
  assert.equal(summary.requests.queue.p50, 300);
  assert.equal(summary.requests.queue.p95, 500);
  // TTFT：仅 trace-001 有 first_token → 1000ms
  assert.equal(summary.requests.ttft.p50, 1000);
  assert.equal(summary.requests.ttft.n, 1);

  // 模型级
  const chat = summary.models.find((m) => m.name === "deepseek-chat");
  const reasoner = summary.models.find((m) => m.name === "deepseek-reasoner");
  assert.equal(chat.attempts, 3);
  assert.equal(chat.success, 2);
  assert.equal(chat.cancelled, 1);
  assert.equal(reasoner.attempts, 1);
  assert.equal(reasoner.failed, 1);
  assert.deepEqual(reasoner.error_kinds, { rate_limit: 1 });
  // 重试归属：同模型在单 trace 内的重复 attempt（reasoner→chat 是回退，不是同模型重试）
  assert.equal(chat.retries, 0);
  assert.equal(reasoner.retries, 0);

  // Token：4200+1200 in / 860+300 out
  assert.equal(summary.tokens.input, 5400);
  assert.equal(summary.tokens.output, 1160);
  assert.equal(summary.tokens.cached, 0);
  assert.equal(summary.tokens.events_with_usage, 2);

  // 成本：chat 0.00208 + 0.000654；reasoner failed 无 usage → usage_missing
  assert.ok(Math.abs(summary.cost.amount - 0.002734) < 1e-9, String(summary.cost.amount));
  assert.equal(summary.cost.priced_events, 2);
  assert.deepEqual(summary.cost.missing, { usage_missing: 1 });
  assert.equal(summary.cost.source, "test/fixtures/prices.json");

  // 工具：fs/read 2 次调用 [500, 200]
  const tool = summary.tools.find((t) => t.name === "fs/read");
  assert.equal(tool.calls, 2);
  assert.equal(tool.success, 2);
  assert.deepEqual(tool.latency, { p50: 200, p95: 500, p99: 500, avg: 350, n: 2 });

  // 插件：test-plugin onRequest 400ms
  const plugin = summary.plugins.find((p) => p.name === "test-plugin");
  assert.equal(plugin.hooks.onRequest.calls, 1);
  assert.equal(plugin.hooks.onRequest.latency.p50, 400);
  assert.equal(plugin.errors, 0);

  // 错误分类
  assert.deepEqual(summary.errors.kinds, { rate_limit: 1 });

  // 数据完整性标注
  assert.equal(summary.data_completeness.events, 21);
  assert.equal(summary.data_completeness.model_attempts, 4);
  assert.ok(summary.data_completeness.note.includes("nearest-rank"));
});

test("aggregate: without catalog cost is null with explicit reason", async () => {
  const events = await loadFixtureEvents();
  const summary = aggregateEvents(events, { catalog: null });
  assert.equal(summary.cost.amount, null); // 无已计价事件 → null 而非 0
  assert.deepEqual(summary.cost.missing, { catalog_missing: 3 }); // 每个闭合 attempt 一次计算
  assert.equal(summary.cost.source, null);
});

test("aggregate: unclosed model attempt in cancelled request counted as cancelled", async () => {
  const events = await loadFixtureEvents();
  const onlyCancelled = events.filter((e) => e.trace_id === "trace-003");
  const summary = aggregateEvents(onlyCancelled);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].cancelled, 1);
  assert.equal(summary.models[0].success, 0);
});

test("aggregate: tool loop hints fire at >=3 calls of same tool per trace", async () => {
  const events = [];
  for (let i = 0; i < 4; i += 1) {
    events.push({ schema_version: "1.0", event: "tool.started", event_id: `e${i}a`, trace_id: "t-loop", span_id: `ls${i}`, timestamp: `2026-08-23T12:0${i}:00.000Z`, tool: { name: "shell/run" } });
    events.push({ schema_version: "1.0", event: "tool.completed", event_id: `e${i}b`, trace_id: "t-loop", span_id: `ls${i}`, timestamp: `2026-08-23T12:0${i}:05.000Z`, duration_ms: 5000, tool: { name: "shell/run" }, result: { status: "success" } });
  }
  const summary = aggregateEvents(events);
  assert.equal(summary.tool_loop_hints.length, 1);
  assert.equal(summary.tool_loop_hints[0].calls, 4);
  assert.equal(summary.tool_loop_hints[0].tool, "shell/run");
});

test("aggregate: groupBy produces per-group rows", async () => {
  const events = await loadFixtureEvents();
  const byDay = aggregateGrouped(events, { groupBy: "day" });
  assert.equal(byDay.length, 1);
  assert.equal(byDay[0].group, "2026-08-23");
  assert.equal(byDay[0].requests, 3);
  assert.equal(byDay[0].input_tokens, 5400);

  const byModel = aggregateGrouped(events, { groupBy: "model" });
  // model 维度只统计携带 model 的事件：chat 6（3+2+1），reasoner 2
  const chatRow = byModel.find((r) => r.group === "deepseek-chat");
  assert.ok(chatRow);
  assert.equal(chatRow.events, 6);
  assert.equal(chatRow.input_tokens, 5400); // 模型分区内的 Token 可重算
  const reasonerRow = byModel.find((r) => r.group === "deepseek-reasoner");
  assert.equal(reasonerRow.events, 2);
  assert.equal(byModel.some((r) => r.group === "unknown"), false); // 无维度信息的事件不参与

  assert.equal(aggregateGrouped(events, { groupBy: "nope" }), null);
});

test("aggregate: slowTraceIds finds requests over threshold", async () => {
  const events = await loadFixtureEvents();
  assert.deepEqual([...slowTraceIds(events, 8500)].sort(), ["trace-002"]); // 8100 < 8500 < 9100
  assert.deepEqual([...slowTraceIds(events, 10000)], []);
  assert.ok(slowTraceIds(events, 8100).has("trace-001"));
});

test("aggregate: trace view builds span tree from parent_id", async () => {
  const events = (await loadFixtureEvents()).filter((e) => e.trace_id === "trace-001");
  const view = buildTraceView(events);
  assert.equal(view.trace_id, "trace-001");
  assert.equal(view.tree.roots.length, 1);
  const root = view.tree.roots[0];
  assert.equal(root.span_id, "span-001");
  assert.equal(root.children.length, 3); // context + model + plugin spans
  const modelNode = root.children.find((n) => n.span_id === "span-002");
  assert.equal(modelNode.children.length, 2); // two tool spans
  assert.equal(view.timeline.length, 12);
  assert.equal(view.timeline[0].event, "request.started");
});

test("aggregate: listRequestRows returns whitelisted fields only", async () => {
  const events = await loadFixtureEvents();
  const rows = listRequestRows(events);
  assert.equal(rows.length, 3);
  const row = rows.find((r) => r.trace_id === "trace-002");
  assert.equal(row.status, "success");
  assert.equal(row.duration_ms, 9100);
  assert.equal(row.retries, 1);
  assert.equal(row.model, "deepseek-chat");
  assert.equal(row.tokens.input, 1200);
  assert.equal(JSON.stringify(row).includes("prompt"), false);
});
