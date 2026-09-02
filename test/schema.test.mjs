import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  EVENT_NAMES,
  validateEvent,
  serializeEvent,
  deserializeEvent,
  newId,
  isIsoUtc,
  toIsoUtc,
  inferStatus,
  eventDomain,
  MAX_EVENT_BYTES,
} from "../src/schema.mjs";

const baseEvent = {
  schema_version: "1.0",
  event: "model.completed",
  event_id: "evt-001",
  trace_id: "trace-001",
  span_id: "span-003",
  parent_id: "span-001",
  timestamp: "2026-08-23T12:00:00.000Z",
  duration_ms: 8420,
  model: { provider: "deepseek", name: "deepseek-chat", request_type: "chat" },
  usage: { input_tokens: 4200, output_tokens: 860, cached_input_tokens: 0, reasoning_tokens: null },
  result: { status: "success", finish_reason: "stop" },
  privacy: { content_captured: false, redactions: 0 },
};

test("schema: 12 lifecycle event names are fixed", () => {
  assert.equal(EVENT_NAMES.length, 12);
  for (const name of ["request.started", "request.context", "model.requested", "model.first_token", "model.completed", "model.failed", "tool.started", "tool.completed", "plugin.started", "plugin.completed", "request.completed", "request.cancelled"]) {
    assert.ok(EVENT_NAMES.includes(name), name);
  }
});

test("schema: valid event passes validation", () => {
  const result = validateEvent(baseEvent);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("schema: required fields enforced", () => {
  const missing = { event: "model.completed" };
  const result = validateEvent(missing);
  assert.equal(result.ok, false);
  for (const field of ["schema_version", "event_id", "trace_id", "span_id", "timestamp"]) {
    assert.ok(result.errors.some((e) => e.includes(field)), `${field} should be reported`);
  }
});

test("schema: unknown event name rejected", () => {
  const result = validateEvent({ ...baseEvent, event: "tool.failed" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown event name")));
});

test("schema: incompatible major version reports explicitly (not silently skipped at validation level)", () => {
  const result = validateEvent({ ...baseEvent, schema_version: "2.0" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unsupported schema_version: 2.0")));
});

test("schema: timestamp must be ISO 8601 UTC", () => {
  assert.equal(isIsoUtc("2026-08-23T12:00:00.000Z"), true);
  assert.equal(isIsoUtc("2026-08-23T12:00:00Z"), true);
  assert.equal(isIsoUtc("2026-08-23 12:00:00"), false);
  assert.equal(isIsoUtc("2026-08-23T12:00:00+08:00"), false);
  const result = validateEvent({ ...baseEvent, timestamp: "yesterday" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("ISO 8601 UTC")));
});

test("schema: unknown metrics stay null, never coerced to 0", () => {
  const event = { ...baseEvent, usage: { input_tokens: null, output_tokens: null, reasoning_tokens: null } };
  const result = validateEvent(event);
  assert.equal(result.ok, true);
  assert.equal(event.usage.input_tokens, null);
  assert.equal(event.usage.output_tokens, null);
});

test("schema: negative or fractional metrics rejected", () => {
  const negative = validateEvent({ ...baseEvent, usage: { input_tokens: -1 } });
  assert.equal(negative.ok, false);
  const fractional = validateEvent({ ...baseEvent, duration_ms: 12.5 });
  assert.equal(fractional.ok, false);
});

test("schema: invalid result.status rejected", () => {
  const result = validateEvent({ ...baseEvent, result: { status: "ok" } });
  assert.equal(result.ok, false);
});

test("schema: tool/plugin events require names", () => {
  assert.equal(validateEvent({ ...baseEvent, event: "tool.started", tool: {} }).ok, false);
  assert.equal(validateEvent({ ...baseEvent, event: "plugin.started", plugin: { name: "p" } }).ok, true);
});

test("schema: serialize/deserialize roundtrip, bad line fails cleanly", () => {
  const line = serializeEvent(baseEvent);
  assert.equal(line.includes("\n"), false);
  const parsed = deserializeEvent(line);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.event, baseEvent);
  assert.equal(deserializeEvent("{nope").ok, false);
});

test("schema: newId prefixes are unique and well-formed", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(newId("event"));
  assert.equal(ids.size, 200);
  assert.match(newId("trace"), /^trace-[0-9a-f]{12}$/);
  assert.match(newId("span"), /^span-[0-9a-f]{12}$/);
});

test("schema: toIsoUtc produces parseable UTC strings", () => {
  const iso = toIsoUtc(1755940800000);
  assert.ok(isIsoUtc(iso), iso);
  assert.equal(Date.parse(iso), 1755940800000);
});

test("schema: inferStatus and eventDomain", () => {
  assert.equal(inferStatus(baseEvent), "success");
  assert.equal(inferStatus({ ...baseEvent, event: "model.failed", result: null }), "failed");
  assert.equal(inferStatus({ ...baseEvent, event: "request.cancelled", result: null }), "cancelled");
  assert.equal(inferStatus({ ...baseEvent, result: { status: "timeout" } }), "timeout"); // 显式状态优先
  assert.equal(eventDomain("tool.started"), "tool");
  assert.equal(eventDomain("plugin.completed"), "plugin");
  assert.equal(eventDomain("request.context"), "request");
  assert.equal(eventDomain("model.first_token"), "model");
});

test("schema: event size budget constant is 64KB", () => {
  assert.equal(MAX_EVENT_BYTES, 65536);
});
