import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionState,
  mapSessionEvent,
  createDshAdapter,
  createHostCapabilities,
  normalizeErrorKind,
  MAPPED_HOST_EVENTS,
} from "../src/adapter-dsh.mjs";
import { createRecorder } from "../src/recorder.mjs";
import { createJsonlStore } from "../src/store.mjs";
import { aggregateEvents, countRetries } from "../src/aggregate.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "dsh-tel-dsh-"));
}

// 事件形状全部取自 2026-09 实测的 @deepseek-ai/dsh 0.1.5-rc.1 真实会话日志
const T0 = Date.parse("2026-08-23T12:00:00.000Z");
const at = (ms) => T0 + ms;
function host(type, data, ms, extra = {}) {
  return Object.assign({ type, seq: 1, time: at(ms), data }, extra);
}
function mapAll(events, options) {
  const state = createSessionState("sess-1", options);
  const out = [];
  for (const event of events) out.push(...mapSessionEvent(state, event));
  return { state, out };
}
function named(events, name) {
  return events.filter((event) => event.event === name);
}

test("adapter-dsh: turn/step/model/tool 映射成计划 §3.1 的 span 结构", () => {
  const { out } = mapAll([
    host("turn/start", { turn: 1 }, 0),
    host("step/start", { turn: 1, step: 1 }, 100),
    host("assistant/chunk", { turn: 1, step: 1, chunk: { type: "block-start" } }, 200),
    host("assistant/message", {
      turn: 1, step: 1,
      message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" } },
      usage: { inputTokens: 12040, outputTokens: 420, cacheReadTokens: 9600, reasoningTokens: 130 },
    }, 1500),
    host("tool/call", { turn: 1, step: 1, callId: "call_x", name: "run_code", arguments: "{\"code\":\"secret\"}" }, 1600),
    host("tool/result", {
      turn: 1, step: 1,
      message: { source: { kind: "tool", callId: "call_x" }, content: [{ type: "tool-result", isError: false }] },
    }, 2000),
    host("step/end", { turn: 1, step: 1 }, 2100),
    host("turn/end", { turn: 1, reason: { kind: "completed" } }, 3000),
  ]);

  assert.deepEqual(out.map((e) => e.event), [
    "request.started", "model.requested", "model.first_token", "model.completed",
    "tool.started", "tool.completed", "request.completed",
  ]);

  const req = named(out, "request.started")[0];
  assert.equal(req.trace_id, "sess-1#t1");
  assert.equal(req.span_id, "req-t1");
  assert.equal(req.request_id, "turn-1");
  assert.equal(req.timestamp, new Date(at(0)).toISOString());

  const modelReq = named(out, "model.requested")[0];
  assert.equal(modelReq.span_id, "mdl-t1-s1");
  assert.equal(modelReq.parent_id, "req-t1", "model span 的父是 request span");

  const first = named(out, "model.first_token")[0];
  assert.equal(first.span_id, "mdl-t1-s1", "first_token 必须挂在同一个 model span 上");
  assert.equal(first.timestamp, new Date(at(200)).toISOString());

  const done = named(out, "model.completed")[0];
  assert.equal(done.duration_ms, 1400);
  assert.deepEqual(done.model, { name: "deepseek-v4-pro", provider: "deepseek-official" });
  assert.deepEqual(done.usage, {
    input_tokens: 12040, output_tokens: 420, cached_input_tokens: 9600, reasoning_tokens: 130,
  });

  const toolReq = named(out, "tool.started")[0];
  assert.equal(toolReq.span_id, "tool:call_x");
  assert.equal(toolReq.parent_id, "mdl-t1-s1", "tool span 的父是 model attempt span");
  assert.deepEqual(toolReq.tool, { name: "run_code" });

  const toolDone = named(out, "tool.completed")[0];
  assert.equal(toolDone.duration_ms, 400);
  assert.equal(toolDone.result.status, "success");

  const reqDone = named(out, "request.completed")[0];
  assert.equal(reqDone.duration_ms, 3000);
  assert.equal(reqDone.result.status, "success");
  // step/end 在 model.completed 之后不应再补一条伪造的失败
  assert.equal(named(out, "model.failed").length, 0);
});

test("adapter-dsh: 工具失败 → status=failed + error.kind，且不臆造缺失指标", () => {
  const { out } = mapAll([
    host("turn/start", { turn: 2 }, 0),
    host("step/start", { turn: 2, step: 1 }, 10),
    host("tool/result", {
      turn: 2, step: 1,
      message: { source: { kind: "tool", callId: "call_lost" }, content: [{ type: "tool-result", isError: true }] },
      error: { name: "ToolNotFoundError", code: "UNKNOWN_TOOL" },
    }, 90),
  ]);
  const done = named(out, "tool.completed")[0];
  assert.equal(done.result.status, "failed");
  assert.deepEqual(done.error, { kind: "tool_not_found" });
  assert.equal(done.span_id, "tool:call_lost");
  // 没有 tool/call 就没有开始时间：不写 duration（未知即省略，不补 0）
  assert.equal(done.duration_ms, undefined);
  assert.deepEqual(done.tool, { name: "unknown" });
});

test("adapter-dsh: 三种失败标记分别判失败，无标记不误判", () => {
  const message = { source: { kind: "tool", callId: "call_1" }, content: [{}] };

  // 1) 宿主把失败标在 message.isError，content 块里没有 isError
  const messageOnly = mapAll([
    host("turn/start", { turn: 2 }, 0),
    host("tool/result", { turn: 2, step: 1, message: Object.assign({ isError: true }, message) }, 90),
  ]);
  const failed = named(messageOnly.out, "tool.completed")[0];
  assert.equal(failed.result.status, "failed");
  assert.deepEqual(failed.error, { kind: "tool_error" });

  // 2) 同上再带 data.error.name → 落到具体 error.kind
  const withDetail = mapAll([
    host("turn/start", { turn: 2 }, 0),
    host("tool/result", {
      turn: 2, step: 1, message: Object.assign({ isError: true }, message), error: { name: "ToolNotFoundError" },
    }, 90),
  ]);
  const detailed = named(withDetail.out, "tool.completed")[0];
  assert.equal(detailed.result.status, "failed");
  assert.deepEqual(detailed.error, { kind: "tool_not_found" });

  // 3) 无任何错误标记 → success，且结果里不补 error 字段（防过度判失败）
  const clean = mapAll([
    host("turn/start", { turn: 2 }, 0),
    host("tool/result", { turn: 2, step: 1, message }, 90),
  ]);
  const ok = named(clean.out, "tool.completed")[0];
  assert.equal(ok.result.status, "success");
  assert.equal("error" in ok, false);
});

test("adapter-dsh: llm/retry 映射为「失败 attempt + 新 attempt」，重试口径正确", () => {
  const { out } = mapAll([
    host("turn/start", { turn: 3 }, 0),
    host("step/start", { turn: 3, step: 1 }, 10),
    host("llm/retry", { turn: 3, step: 1, retry: 1, maxRetries: 2, failure: { code: "TRANSPORT" } }, 500),
    host("assistant/chunk", { turn: 3, step: 1 }, 900),
    host("assistant/message", { turn: 3, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } } }, 2000),
    host("turn/end", { turn: 3, reason: { kind: "completed" } }, 2500),
  ]);
  const failed = named(out, "model.failed")[0];
  assert.equal(failed.span_id, "mdl-t3-s1");
  assert.deepEqual(failed.error, { kind: "transport" });
  assert.equal(failed.duration_ms, 490);

  const requested = named(out, "model.requested");
  assert.equal(requested.length, 2, "重试会产生第二个 attempt");
  assert.equal(requested[1].span_id, "mdl-t3-s1-a2");
  assert.equal(requested[1].parent_id, "req-t3");

  // 完成事件必须落在「重试后」的那个 attempt 上
  assert.equal(named(out, "model.completed")[0].span_id, "mdl-t3-s1-a2");

  // 聚合口径：一个 turn 内正常的多步调用不是重试，只有失败后重发才算
  assert.equal(countRetries(out), 1);
  const steps = [
    host("turn/start", { turn: 9 }, 0),
    host("step/start", { turn: 9, step: 1 }, 10),
    host("assistant/message", { turn: 9, step: 1 }, 20),
    host("step/start", { turn: 9, step: 2 }, 30),
    host("assistant/message", { turn: 9, step: 2 }, 40),
    host("step/start", { turn: 9, step: 3 }, 50),
    host("assistant/message", { turn: 9, step: 3 }, 60),
  ];
  assert.equal(countRetries(mapAll(steps).out), 0, "多步不是重试（旧口径会算成 2 次）");
});
test("adapter-dsh: 首 token 以原始 chunk 为准，压缩 run 只在终态回填最小 time0", () => {
  // 原始 assistant/chunk 的 append 顺序就是时间顺序
  const a = mapAll([
    host("turn/start", { turn: 1 }, 0),
    host("step/start", { turn: 1, step: 1 }, 100),
    host("assistant/chunk", { turn: 1, step: 1 }, 300),
    host("reasoning-chunks", { turn: 1, step: 1, dt: [1], texts: ["x"] }, 400, { time0: at(250) }),
    host("assistant/message", { turn: 1, step: 1 }, 1500),
  ]).out;
  assert.equal(named(a, "model.first_token")[0].timestamp, new Date(at(300)).toISOString());
  assert.equal(named(a, "model.first_token").length, 1, "每个 attempt 只发一条 first_token");

  // 只剩压缩 run 时（老日志/回放历史）：取最小 time0 回填，而不是「第一个看到的 run」
  const b = mapAll([
    host("turn/start", { turn: 2 }, 0),
    host("step/start", { turn: 2, step: 1 }, 100),
    host("tool-call-chunks", { turn: 2, step: 1 }, 900, { time0: at(900) }),
    host("reasoning-chunks", { turn: 2, step: 1 }, 400, { time0: at(400) }),
    host("assistant/message", { turn: 2, step: 1 }, 1500),
  ]).out;
  const first = named(b, "model.first_token")[0];
  assert.equal(first.timestamp, new Date(at(400)).toISOString(), "必须取最小 time0（否则 TTFT 会虚高数倍）");
  assert.equal(first.span_id, "mdl-t2-s1");
});

test("adapter-dsh: 内容字段永不进入产出（隐私 §6）", () => {
  const { out } = mapAll([
    host("turn/start", { turn: 1 }, 0),
    host("request/header", { header: { config: { provider: "p", model: "m" }, system: "SECRET_SYSTEM" } }, 5),
    host("step/start", { turn: 1, step: 1 }, 10),
    host("tool/call", { turn: 1, step: 1, callId: "c1", name: "run_code", arguments: "SECRET_ARGS" }, 20),
    host("tool/result", { turn: 1, step: 1, message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "SECRET_OUTPUT" }] }] } }, 30),
    host("text-chunks", { turn: 1, step: 1, texts: ["SECRET_STREAM"], dt: [1] }, 40, { time0: at(40) }),
    host("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "SECRET_MSG" }], source: { kind: "model", provider: "p", model: "m" } } }, 50),
    host("turn/end", { turn: 1, reason: { kind: "completed" } }, 60),
  ]);
  const dump = JSON.stringify(out);
  for (const secret of ["SECRET_SYSTEM", "SECRET_ARGS", "SECRET_OUTPUT", "SECRET_STREAM", "SECRET_MSG"]) {
    assert.equal(dump.includes(secret), false, "不得采集内容：" + secret);
  }
  // 元数据仍然要保留
  assert.equal(named(out, "tool.started")[0].tool.name, "run_code");
  assert.equal(named(out, "model.completed")[0].model.name, "m");
});

test("adapter-dsh: turn/end 的 reason 映射（成功/取消/失败）", () => {
  const base = (turn) => [
    host("turn/start", { turn }, 0),
    host("step/start", { turn, step: 1 }, 10),
    host("assistant/message", { turn, step: 1 }, 20),
  ];
  const ok = mapAll([...base(1), host("turn/end", { turn: 1, reason: { kind: "completed" } }, 100)]).out;
  assert.equal(named(ok, "request.completed")[0].result.status, "success");

  const cancelled = mapAll([...base(2), host("turn/end", { turn: 2, reason: { kind: "aborted", reason: "user" } }, 100)]).out;
  assert.equal(named(cancelled, "request.cancelled")[0].result.status, "cancelled");
  assert.equal(named(cancelled, "request.completed").length, 0);

  const failed = mapAll([...base(3), host("turn/end", { turn: 3, reason: { kind: "error", error: { code: "RATE_LIMIT" } } }, 100)]).out;
  assert.equal(named(failed, "request.completed")[0].result.status, "failed");
  assert.deepEqual(named(failed, "request.completed")[0].error, { kind: "rate_limit" });

  const maxTokens = mapAll([...base(4), host("turn/end", { turn: 4, reason: { kind: "max-tokens" } }, 100)]).out;
  assert.equal(named(maxTokens, "request.completed")[0].result.status, "success");
});

test("adapter-dsh: hook/invoked + hook/result 映射为 plugin span（§4.4）", () => {
  const { out } = mapAll([
    host("turn/start", { turn: 1 }, 0),
    host("hook/invoked", { turn: 1, point: "pre-tool-use", dialect: "claude-code", handlerId: "h-1" }, 100),
    host("hook/result", { turn: 1, point: "pre-tool-use", handlerId: "h-1", decision: "allow", exitCode: 0, durationMs: 42 }, 142),
    host("hook/invoked", { turn: 1, point: "pre-tool-use", handlerId: "h-2" }, 200),
    host("hook/result", { turn: 1, point: "pre-tool-use", handlerId: "h-2", decision: "deny", exitCode: 2, durationMs: 7 }, 207),
    host("turn/end", { turn: 1, reason: { kind: "completed" } }, 300),
  ]);
  const started = named(out, "plugin.started");
  assert.equal(started.length, 2);
  assert.deepEqual(started[0].plugin, { name: "h-1", hook: "pre-tool-use" });
  const ok = named(out, "plugin.completed")[0];
  assert.equal(ok.result.status, "success");
  assert.equal(ok.duration_ms, 42);
  const denied = named(out, "plugin.completed")[1];
  assert.equal(denied.result.status, "failed");
  assert.deepEqual(denied.error, { kind: "hook_exit_2" });
  assert.equal(denied.span_id, started[1].span_id, "started/completed 必须同 span 才配得上对");
});

test("adapter-dsh: 未知事件被忽略且不抛错；step 未闭合时如实记录 no_completion", () => {
  const { state, out } = mapAll([
    host("turn/start", { turn: 1 }, 0),
    host("session/title", { title: "x" }, 5),
    host("todo/write", { items: [] }, 6),
    host("step/start", { turn: 1, step: 1 }, 10),
    host("step/end", { turn: 1, step: 1 }, 90),
  ]);
  assert.equal(state.counters.ignored, 2);
  assert.equal(named(out, "model.failed")[0].error.kind, "no_completion");
});

test("adapter-dsh: attach 订阅宿主总线、detach 全部解绑", () => {
  const bound = [];
  const disposed = [];
  const ctx = {
    on(name, listener) {
      bound.push(name);
      return () => disposed.push(name);
    },
  };
  const adapter = createDshAdapter(null, { profile: "web" });
  adapter.attach(ctx);
  assert.deepEqual(bound, ["session/created", "session/event", "session/flush", "session/disposed"]);
  assert.equal(adapter.snapshot().attached, true);
  adapter.detach();
  assert.deepEqual(disposed, bound);
  assert.equal(adapter.snapshot().attached, false);
  assert.throws(() => createDshAdapter(null).attach({}), /ctx\.on/);
});

test("adapter-dsh: fail-open —— recorder 抛错不冒泡到宿主", () => {
  const adapter = createDshAdapter({
    record() { throw new Error("boom"); },
  });
  assert.doesNotThrow(() => {
    const n = adapter.ingest({ id: "s1" }, host("turn/start", { turn: 1 }, 0));
    assert.equal(n, 0);
  });
  assert.equal(adapter.snapshot().errors, 1);
});

test("adapter-dsh: 能力声明如实（partial，不伪装成 full）", () => {
  const caps = createHostCapabilities();
  assert.equal(caps.lifecycle_hooks, "partial");
  assert.equal(caps.usage_tokens, "confirmed");
  assert.equal(caps.plugin_lifecycle, "partial");
  assert.equal(caps.cost_model, "catalog");
  assert.ok(MAPPED_HOST_EVENTS.includes("turn/start"));
  assert.ok(MAPPED_HOST_EVENTS.includes("assistant/chunk"));
  assert.equal(normalizeErrorKind("ToolNotFoundError"), "tool_not_found");
  assert.equal(normalizeErrorKind("TRANSPORT"), "transport");
  assert.equal(normalizeErrorKind(undefined), "unknown");
});

test("adapter-dsh: 端到端 —— 真实形状事件流经 recorder 落盘后可聚合", async () => {
  const dir = tmpDir();
  const recorder = createRecorder({ config: { path: dir, sample_rate: 1 } });
  await recorder.start();
  const adapter = createDshAdapter(recorder, { profile: "web" });
  const session = { id: "sess-e2e" };
  const stream = [
    host("turn/start", { turn: 1 }, 0),
    host("step/start", { turn: 1, step: 1 }, 10),
    host("assistant/chunk", { turn: 1, step: 1 }, 60),
    host("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 }, message: { source: { kind: "model", provider: "p", model: "m" } } }, 500),
    host("tool/call", { turn: 1, step: 1, callId: "c1", name: "run_code" }, 510),
    host("tool/result", { turn: 1, step: 1, message: { source: { kind: "tool", callId: "c1" }, content: [{}] } }, 900),
    host("step/end", { turn: 1, step: 1 }, 950),
    host("turn/end", { turn: 1, reason: { kind: "completed" } }, 1000),
  ];
  for (const event of stream) adapter.ingest(session, event);
  await recorder.close();

  const snap = adapter.snapshot();
  assert.equal(snap.recorded, 7, "7 条映射事件都应落盘");
  assert.equal(snap.invalid, 0);
  assert.equal(snap.errors, 0);

  const store = createJsonlStore({ path: dir });
  const { events } = await store.readEvents();
  assert.equal(events.length, 7);
  const summary = aggregateEvents(events);
  assert.equal(summary.requests.total, 1);
  assert.equal(summary.requests.success, 1);
  assert.equal(summary.data_completeness.tool_calls, 1);
  assert.equal(summary.tokens.input, 100);
  assert.equal(summary.tokens.output, 20);
  assert.equal(summary.requests.ttft.p95, 50, "TTFT = assistant/chunk - step/start");
});