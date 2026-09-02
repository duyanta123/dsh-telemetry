import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecorder } from "../src/recorder.mjs";
import { createEventBusAdapter, createCapabilities, detectCapabilities } from "../src/adapter.mjs";
import { createJsonlStore } from "../src/store.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "dsh-tel-rec-"));
}

function makeEvent(overrides = {}) {
  return {
    event: "model.completed",
    trace_id: "trace-r1",
    span_id: "span-r1",
    timestamp: "2026-08-23T12:00:00.000Z",
    model: { provider: "deepseek", name: "deepseek-chat", request_type: "chat" },
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, reasoning_tokens: null },
    result: { status: "success" },
    ...overrides,
  };
}

async function recordedEvents(config, records) {
  const dir = config?.path ?? tmpDir();
  const recorder = createRecorder({ config: { path: dir, ...(config ?? {}) } });
  await recorder.start();
  for (const entry of records) {
    // 条目要么是事件对象，要么是 { event, metadata } 包装
    const wrapped = entry.metadata !== undefined;
    const event = wrapped ? entry.event : entry;
    recorder.record(event, wrapped ? { metadata: entry.metadata } : undefined);
  }
  await recorder.close();
  const store = createJsonlStore({ path: dir });
  const { events: stored } = await store.readEvents();
  return { stored, dir, recorder };
}

test("recorder: fills missing ids and timestamp without fabricating metrics", async () => {
  const { stored } = await recordedEvents({}, [makeEvent({ trace_id: undefined, span_id: undefined, timestamp: undefined })]);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].event_id.startsWith("evt-"));
  assert.ok(stored[0].span_id.startsWith("span-"));
  assert.equal(stored[0].trace_id, stored[0].span_id); // trace 缺省挂到自身 span
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(stored[0].timestamp));
  assert.equal(stored[0].usage.input_tokens, 100); // 指标不改动
});

test("recorder: no content fields by default — metadata absent unless safe mode", async () => {
  const { stored } = await recordedEvents({}, [makeEvent()]);
  assert.equal("metadata" in stored[0], false);
  assert.equal(stored[0].privacy.content_captured, false);
});

test("recorder: safe mode redacts metadata and records privacy block", async () => {
  const { stored } = await recordedEvents({ capture_metadata: "safe" }, [
    { event: makeEvent() },
    { event: makeEvent({ trace_id: "t-safe" }), metadata: { input_bytes: 2048, api_key: "sk-nope", url: "https://u:p@h.example/x" } },
  ]);
  const withMeta = stored.find((e) => "metadata" in e);
  assert.ok(withMeta, "safe-mode event should carry redacted metadata");
  assert.equal(withMeta.metadata.input_bytes, 2048);
  assert.equal(withMeta.metadata.api_key, undefined);
  assert.equal(withMeta.metadata.url.includes(":p@"), false);
  assert.equal(withMeta.privacy.content_captured, false);
  assert.ok(withMeta.privacy.redactions >= 2);
  assert.ok(withMeta.privacy.rules.includes("api_key"));
});

test("recorder: hash_names covers tool/plugin/model/profile (§6.1)", async () => {
  const { stored } = await recordedEvents({ hash_names: true }, [
    {
      ...makeEvent(),
      tool: { name: "fs/read" },
      plugin: { name: "test-plugin", hook: "onRequest" },
      session: { profile: "web" },
    },
  ]);
  assert.match(stored[0].model.name, /^h:[0-9a-f]{16}$/);
  assert.match(stored[0].tool.name, /^h:[0-9a-f]{16}$/);
  assert.match(stored[0].plugin.name, /^h:[0-9a-f]{16}$/);
  assert.match(stored[0].session.profile, /^h:[0-9a-f]{16}$/);
});

test("recorder: sampling — errors always kept, rate respected per trace", async () => {
  const { stored, recorder } = await recordedEvents({ sample_rate: 0 }, [
    makeEvent({ trace_id: "t-a", event: "model.completed", result: { status: "success" } }),
    makeEvent({ trace_id: "t-b", event: "model.failed", error: { kind: "timeout" }, result: { status: "failed" } }),
    makeEvent({ trace_id: "t-c", event: "request.cancelled", result: { status: "cancelled" } }),
  ]);
  // rate=0：普通事件全被采样掉；错误/取消始终保留（errors_always_sample 默认 true）
  assert.equal(stored.filter((e) => e.trace_id === "t-a").length, 0);
  assert.equal(stored.filter((e) => e.trace_id === "t-b").length, 1);
  assert.equal(stored.filter((e) => e.trace_id === "t-c").length, 1);
  assert.equal(recorder.counters.sampled_out, 1);
});

test("recorder: sampling metadata written into kept events (§7.3)", async () => {
  const { stored } = await recordedEvents({ sample_rate: 1 }, [makeEvent()]);
  assert.equal(stored[0].sampling.strategy, "per-trace-hash-v1");
  assert.equal(stored[0].sampling.rate, 1);
  assert.equal(stored[0].sampling.errors_always_sample, true);
});

test("recorder: disabled config records nothing and creates no files", async () => {
  const dir = tmpDir();
  const recorder = createRecorder({ config: { path: dir, enabled: false } });
  await recorder.start();
  const result = recorder.record(makeEvent());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disabled");
  await recorder.close();
  const store = createJsonlStore({ path: dir });
  const { events } = await store.readEvents();
  assert.equal(events.length, 0);
});

test("recorder: fail-open — sink errors never propagate from record()", async () => {
  const recorder = createRecorder({ config: { path: tmpDir() } });
  await recorder.start();
  recorder.sink.write = () => {
    throw new Error("sink exploded");
  };
  const result = recorder.record(makeEvent());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "recorder_error");
  assert.equal(recorder.counters.errors, 1);
  await recorder.close();
});

test("recorder: invalid events counted and not written", async () => {
  const dir = tmpDir();
  const recorder = createRecorder({ config: { path: dir } });
  await recorder.start();
  const result = recorder.record({ event: "not-an-event", trace_id: "t", span_id: "s" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_event");
  assert.equal(recorder.counters.invalid, 1);
  await recorder.close();
  const store = createJsonlStore({ path: dir });
  const { events } = await store.readEvents();
  assert.equal(events.length, 0);
});

test("recorder: attach(adapter) consumes emitted events", async () => {
  const dir = tmpDir();
  const recorder = createRecorder({ config: { path: dir } });
  await recorder.start();
  const adapter = createEventBusAdapter();
  const detach = recorder.attach(adapter);
  adapter.emit(makeEvent({ trace_id: "t-att" }));
  detach();
  adapter.emit(makeEvent({ trace_id: "t-after" }));
  await recorder.close();
  const store = createJsonlStore({ path: dir });
  const { events } = await store.readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].trace_id, "t-att");
});

test("recorder: adapter handler exceptions are isolated (fail-open bus)", () => {
  const adapter = createEventBusAdapter();
  let secondCalled = false;
  adapter.on("*", () => {
    throw new Error("handler bug");
  });
  adapter.on("*", () => {
    secondCalled = true;
  });
  const delivered = adapter.emit({ event: "request.started" });
  assert.equal(secondCalled, true);
  assert.equal(delivered, 1);
});

test("adapter: capabilities honestly report unconfirmed host hooks (Phase 0 验收)", () => {
  const caps = createCapabilities();
  assert.equal(caps.lifecycle_hooks, "unconfirmed");
  assert.equal(detectCapabilities({ someHost: true }).lifecycle_hooks, "unconfirmed");
  const bus = createEventBusAdapter();
  assert.equal(bus.getCapabilities().lifecycle_hooks, "none");
});

test("recorder: status reports enabled/store without leaking paths (§11)", async () => {
  const recorder = createRecorder({ config: { path: tmpDir() } });
  const status = recorder.status();
  assert.equal(status.enabled, true);
  assert.equal(status.config_summary.store, "jsonl");
  assert.equal(JSON.stringify(status).includes("dsh-tel-rec-"), false);
});
