import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, resolveConfig, loadConfigFile, parseDurationOrTimestamp, sinceUntilRange, BUDGET_LIMITS, resolveDataPath } from "../src/config.mjs";

test("config: defaults match the plan (§11)", () => {
  const { config, ok, errors } = resolveConfig({});
  assert.equal(ok, true, errors.join("; "));
  assert.equal(config.enabled, true);
  assert.equal(config.store, "jsonl");
  assert.equal(config.sample_rate, 1);
  assert.equal(config.errors_always_sample, true);
  assert.equal(config.slow_request_ms, 10000);
  assert.equal(config.capture_metadata, "none");
  assert.equal(config.hash_names, false);
  assert.equal(config.retention_days, 7);
  assert.equal(config.max_file_mb, 100);
  assert.equal(config.flush_interval_ms, 1000);
  assert.equal(config.price_catalog, null);
});

test("config: unknown keys ignored, valid overrides applied", () => {
  const { config, ok } = resolveConfig({ file: { store: "sqlite", future_key: 1, path: "/tmp/x" } });
  assert.equal(ok, true);
  assert.equal(config.store, "sqlite");
  assert.equal(config.path, "/tmp/x");
  assert.equal("future_key" in config, false);
});

test("config: type errors removed and reported, safe defaults kept", () => {
  const { config, ok, errors } = resolveConfig({ file: { sample_rate: "high", retention_days: -3, store: "mongodb" } });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("sample_rate")));
  assert.equal(config.sample_rate, DEFAULT_CONFIG.sample_rate);
  assert.equal(config.store, "jsonl"); // 非法 store 回退安全默认
});

test("config: sample_rate clamped into [0,1]", () => {
  assert.equal(resolveConfig({ file: { sample_rate: 1.5 } }).config.sample_rate, DEFAULT_CONFIG.sample_rate);
});

test("config: budget limits clamp batch/queue/flush", () => {
  const { config } = resolveConfig({ file: { batch_size: 100000, max_queue_events: 999999, flush_interval_ms: 1 } });
  assert.equal(config.batch_size, BUDGET_LIMITS.max_batch_size);
  assert.equal(config.max_queue_events, BUDGET_LIMITS.max_queue_events);
  assert.equal(config.flush_interval_ms, BUDGET_LIMITS.min_flush_interval_ms);
});

test("config: invalid capture_metadata falls back to none", () => {
  const { config } = resolveConfig({ file: { capture_metadata: "full" } });
  assert.equal(config.capture_metadata, "none");
});

test("config: custom redact rules compile; invalid patterns reported", () => {
  const good = resolveConfig({
    file: { redact_rules: [{ name: "employee_id", pattern: "EMP-\\d+" }, { name: "bad", pattern: "([unclosed" }] },
  });
  assert.equal(good.config.redact_rules.length, 1);
  assert.ok(good.errors.some((e) => e.includes("bad")));
});

test("config: loadConfigFile on unreadable file → disabled safe default (不猜测用户意图)", () => {
  const loaded = loadConfigFile(join("Z:", "definitely", "missing", "telemetry.json"));
  assert.equal(loaded.ok, false);
  assert.equal(loaded.config.enabled, false);
});

test("config: loadConfigFile with malformed JSON → disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-cfg-"));
  const file = join(dir, "telemetry.json");
  writeFileSync(file, "{not json", "utf8");
  const loaded = loadConfigFile(file);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.config.enabled, false);
});

test("config: valid file loads and enables", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-cfg-"));
  const file = join(dir, "telemetry.json");
  writeFileSync(file, JSON.stringify({ sample_rate: 0.5, hash_names: true }), "utf8");
  const loaded = loadConfigFile(file);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.sample_rate, 0.5);
  assert.equal(loaded.config.hash_names, true);
  assert.equal(loaded.config.enabled, true);
});

test("config: duration parsing (ms/s/m/h/d) and timestamps", () => {
  assert.deepEqual(parseDurationOrTimestamp("500ms"), { absolute: 500, relative: true });
  assert.deepEqual(parseDurationOrTimestamp("7d"), { absolute: 604_800_000, relative: true });
  assert.equal(parseDurationOrTimestamp("1h").absolute, 3_600_000);
  const iso = parseDurationOrTimestamp("2026-08-23T12:00:00.000Z");
  assert.equal(iso.relative, false);
  assert.equal(iso.absolute, Date.parse("2026-08-23T12:00:00.000Z"));
  assert.equal(parseDurationOrTimestamp("nonsense"), null);
  assert.equal(parseDurationOrTimestamp(null), null);
});

test("config: sinceUntilRange resolves relative windows against now", () => {
  const now = 1_800_000_000_000;
  const { from, to } = sinceUntilRange("1h", null, now);
  assert.equal(from, now - 3_600_000);
  assert.equal(to, null);
  const abs = sinceUntilRange("2026-08-23T00:00:00Z", "2026-08-24T00:00:00Z", now);
  assert.equal(abs.from, Date.parse("2026-08-23T00:00:00Z"));
  assert.equal(abs.to, Date.parse("2026-08-24T00:00:00Z"));
});

test("config: ~ expansion and relative path resolution", () => {
  const resolved = resolveDataPath("/abs/dir", "/cwd");
  assert.ok(resolveDataPath("rel/dir", "/cwd").includes("rel"));
  assert.equal(resolveDataPath("/abs/dir"), resolved);
});
