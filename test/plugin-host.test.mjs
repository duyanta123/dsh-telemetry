import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, getTelemetry, telemetryReady } from "../plugin/index.js";
import { createJsonlStore } from "../src/store.mjs";
import { aggregateEvents } from "../src/aggregate.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "dsh-tel-plugin-"));
}

/** 最小 cordis-like ctx：只实现本插件用到的 on / effect / skills。 */
function fakeCtx() {
  const handlers = new Map();
  const disposers = [];
  const ctx = {
    on(name, listener) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(listener);
      return () => {
        const list = handlers.get(name) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(factory) {
      const iterator = factory();
      const step = iterator.next();
      if (!step.done && typeof step.value === "function") disposers.push(step.value);
    },
    skills: { registerProvider() { return () => {}; } },
    fire(name, ...args) {
      for (const listener of [...(handlers.get(name) ?? [])]) listener(...args);
    },
    boundNames() {
      return [...handlers.keys()];
    },
  };
  return { ctx, disposers };
}

const T0 = Date.parse("2026-08-23T12:00:00.000Z");
const at = (ms) => T0 + ms;
const host = (type, data, ms) => ({ type, seq: 1, time: at(ms), data });

test("plugin: apply() 订阅宿主 session 总线，事件落到配置指定的路径", async () => {
  const dir = tmpDir();
  const { ctx, disposers } = fakeCtx();
  const result = apply(ctx, {
    telemetry: { path: dir, store: "jsonl", sample_rate: 1, capture_metadata: "safe" },
    profile: "web",
  });
  await telemetryReady(); // 等 sink 就绪（sink 未就绪时 record() 会如实返回 not_started）

  assert.equal(result.name, "dsh-local-telemetry");
  // 配置透传回归：宿主行 config.telemetry 必须真的生效（曾被当成 opts 丢弃）
  assert.equal(getTelemetry().status().config_summary.capture_metadata, "safe");
  assert.equal(getTelemetry().status().config_summary.store, "jsonl");
  assert.ok(result.hostAdapter, "apply() 应回报宿主适配器状态");
  assert.equal(result.hostAdapter.attached, true);
  assert.deepEqual(ctx.boundNames().sort(), ["session/created", "session/disposed", "session/event", "session/flush"]);

  const session = { id: "sess-plugin" };
  ctx.fire("session/created", session);
  ctx.fire("session/event", session, host("turn/start", { turn: 1 }, 0));
  ctx.fire("session/event", session, host("step/start", { turn: 1, step: 1 }, 10));
  ctx.fire("session/event", session, host("assistant/chunk", { turn: 1, step: 1 }, 60));
  ctx.fire("session/event", session, host("assistant/message", {
    turn: 1, step: 1,
    message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" } },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800 },
  }, 500));
  ctx.fire("session/event", session, host("tool/call", { turn: 1, step: 1, callId: "c1", name: "run_code", arguments: "SECRET" }, 510));
  ctx.fire("session/event", session, host("tool/result", {
    turn: 1, step: 1, message: { source: { kind: "tool", callId: "c1" }, content: [{}] },
  }, 900));
  ctx.fire("session/event", session, host("step/end", { turn: 1, step: 1 }, 950));
  ctx.fire("session/event", session, host("turn/end", { turn: 1, reason: { kind: "completed" } }, 1000));

  // 走一遍宿主 dispose（ctx.effect 注册的清理函数）
  for (const dispose of disposers) await dispose();

  const store = createJsonlStore({ path: dir });
  const { events } = await store.readEvents();
  assert.equal(events.length, 7, "7 条映射事件都应落盘");

  // 关键：配置里的 path 必须真的被用上（getTelemetry 曾经把配置对象当 opts 丢掉）
  assert.equal(events[0].session.profile, "web");
  assert.equal(JSON.stringify(events).includes("SECRET"), false, "内容字段不得落盘");

  const summary = aggregateEvents(events);
  assert.equal(summary.requests.total, 1);
  assert.equal(summary.requests.success, 1);
  assert.equal(summary.data_completeness.tool_calls, 1);
  assert.equal(summary.tokens.input, 1000);
  assert.equal(summary.tokens.output, 200);
  assert.equal(summary.tokens.cached, 800);
  assert.equal(summary.requests.ttft.p95, 50);
  assert.equal(events[0].model, undefined, "request.started 不带模型归属");
  const modelDone = events.find((event) => event.event === "model.completed");
  assert.equal(modelDone.model.name, "deepseek-v4-pro");
});

test("plugin: 宿主没有 session 总线时 fail-open（不抛错、可降级）", () => {
  const calls = [];
  const original = console.warn;
  console.warn = (...args) => calls.push(args.join(" "));
  try {
    const ctx = { effect() {}, skills: { registerProvider() { return () => {}; } } };
    const result = apply(ctx, { telemetry: { path: tmpDir() } });
    assert.equal(result.name, "dsh-local-telemetry");
    assert.equal(result.hostAdapter, null, "无总线时不得假装接入成功");
    // 技能注册依赖可选 peer（@deepseek-ai/dsh-skill-filesystem），此处只要求不因此抛错
    assert.equal(typeof result.skillsRegistered, "boolean");
    assert.equal(calls.some((line) => line.includes("host session bus unavailable")), true);
  } finally {
    console.warn = original;
  }
  // 共享记录器是进程内单例：重复调用返回同一实例（宿主可能从多处访问）
  assert.equal(getTelemetry(), getTelemetry());
});