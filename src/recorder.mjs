/**
 * dsh-local-telemetry — 独立事件记录器（计划 §2 / Phase 1）。
 *
 * 职责链：ID 补全 → 名称哈希（可选）→ metadata 脱敏（仅 safe 模式）→
 * 按 trace 采样 → sink。全部 fail-open：任何异常只计数，不影响业务请求。
 *
 * 刻意不做的事：
 * - 不臆造 duration/token/成本（这些由聚合器从真实事件对推导）；
 * - 不采集内容：metadata 仅在 capture_metadata="safe" 时脱敏后附加；
 * - 不感知宿主私有 API（经 adapter 接入）。
 */

import { createCapabilities } from "./adapter.mjs";
import { resolveConfig, resolveDataPath } from "./config.mjs";
import { createRedactor, getOrCreateSalt, hashName, defaultPrivacy } from "./privacy.mjs";
import { createSampler } from "./sampling.mjs";
import { SCHEMA_VERSION, newId, nowIsoUtc, validateEvent } from "./schema.mjs";
import { JsonlSink } from "./sink-jsonl.mjs";

/**
 * 按已解析配置构造 sink：config.store 决定后端（jsonl | sqlite）。
 *
 * fail-open：sqlite 不可用（Node < 22.5、node:sqlite 被禁用等）时自动降级为
 * jsonl 并带回降级原因，绝不因后端问题阻塞业务（计划 §6.3）。
 *
 * @param {object} config resolveConfig() 产物
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<{ sink: object, kind: "jsonl"|"sqlite", fallback: boolean, reason: string|null }>}
 */
export async function createSink(config, { now = () => Date.now() } = {}) {
  const shared = {
    dir: resolveDataPath(config.path),
    maxFileBytes: config.max_file_mb * 1024 * 1024,
    batchCount: config.batch_size,
    flushIntervalMs: config.flush_interval_ms,
    maxQueue: config.max_queue_events,
    retentionDays: config.retention_days,
    now,
  };
  if (config.store === "sqlite") {
    try {
      const mod = await import("./sink-sqlite.mjs");
      const availability = await mod.sqliteAvailable();
      if (availability.available) {
        return { sink: mod.createSqliteSink(shared), kind: "sqlite", fallback: false, reason: null };
      }
      return {
        sink: new JsonlSink(shared),
        kind: "jsonl",
        fallback: true,
        reason: availability.reason ?? "sqlite unavailable",
      };
    } catch (error) {
      return {
        sink: new JsonlSink(shared),
        kind: "jsonl",
        fallback: true,
        reason: "sqlite init failed (" + (error?.message ?? String(error)) + ")",
      };
    }
  }
  return { sink: new JsonlSink(shared), kind: "jsonl", fallback: false, reason: null };
}

/**
 * @param {object} opts
 * @param {object|undefined} [opts.config] 部分配置（与默认合并）
 * @param {object} [opts.sink] 已构造的 sink（缺省按 config.store 创建对应后端）
 * @param {() => number} [opts.now] 可注入时钟
 */
export function createRecorder(opts = {}) {
  const resolution = resolveConfig({ file: opts.config ? { ...opts.config } : undefined });
  const config = resolution.config;
  const now = opts.now ?? (() => Date.now());

  const recorder = {
    config,
    capabilities: createCapabilities(),
    counters: { recorded: 0, sampled_out: 0, invalid: 0, not_ready: 0, errors: 0 },
    adapter: null,
    sink: opts.sink ?? null,
    _sinkKind: opts.sink?.kind ?? null,
    _sinkFallback: false,
    _sinkFallbackReason: null,
    _salt: null,
    _redactor: null,
    _sampler: null,
    _started: false,
  };

  function ensureSalt() {
    if (recorder._salt === null) {
      recorder._salt = getOrCreateSalt(resolveDataPath(config.path));
    }
    return recorder._salt;
  }

  function ensureSampler() {
    if (recorder._sampler === null) {
      recorder._sampler = createSampler({
        sampleRate: config.sample_rate,
        errorsAlwaysSample: config.errors_always_sample,
        slowRequestMs: config.slow_request_ms,
        salt: ensureSalt(),
      });
    }
    return recorder._sampler;
  }

  function ensureRedactor() {
    if (recorder._redactor === null) {
      recorder._redactor = createRedactor({
        customRules: config.redact_rules,
        absolutePaths: "basename",
        salt: ensureSalt(),
      });
    }
    return recorder._redactor;
  }

  async function start() {
    if (recorder._started) return;
    recorder._started = true;
    if (!recorder.sink) {
      const built = await createSink(config, { now });
      recorder.sink = built.sink;
      recorder._sinkKind = built.kind;
      recorder._sinkFallback = built.fallback;
      recorder._sinkFallbackReason = built.reason;
      if (built.fallback) {
        console.warn?.(
          "[dsh-local-telemetry] store " + JSON.stringify(config.store) +
            " unavailable, falling back to " + JSON.stringify(built.kind) + ": " + built.reason
        );
      }
    }
    if (typeof recorder.sink.start === "function") await recorder.sink.start();
  }

  /**
   * 记录一条事件。返回 { ok, reason }，绝不抛出。
   * @param {object} event 事件（缺失的 id/timestamp 会被补全）
   * @param {object} [metadata] 可选 metadata（仅 capture_metadata="safe" 时脱敏附加）
   */
  function record(event, { metadata } = {}) {
    if (!config.enabled) return { ok: false, reason: "disabled" };
    try {
      const prepared = prepare(event, metadata);
      if (!prepared.ok) {
        recorder.counters.invalid += 1;
        return prepared;
      }
      // start() 是异步的（sqlite 后端需要动态加载）：sink 未就绪时必须如实拒绝，
      // 不能「计数为已记录、实际没落盘」——那是最难发现的一类静默丢数据。
      if (!recorder.sink) {
        recorder.counters.not_ready += 1;
        return { ok: false, reason: "not_started" };
      }
      const sampler = ensureSampler();
      const decision = sampler.decide(prepared.event, { durationMs: prepared.event.duration_ms ?? null });
      if (!decision.kept) {
        recorder.counters.sampled_out += 1;
        recorder.sink?.countDropped?.("sampled_out");
        return { ok: false, reason: "sampled_out" };
      }
      prepared.event.sampling = sampler.metadata();
      const writeResult = recorder.sink?.write?.(prepared.event);
      if (writeResult && writeResult.ok === false) {
        return { ok: false, reason: writeResult.reason ?? "sink_rejected" };
      }
      recorder.counters.recorded += 1;
      return { ok: true, event: prepared.event };
    } catch {
      recorder.counters.errors += 1;
      return { ok: false, reason: "recorder_error" };
    }
  }

  function prepare(event, metadata) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return { ok: false, reason: "invalid_event", errors: ["event must be a JSON object"] };
    }
    const prepared = { ...event };

    // ID / 契约补全：只为身份与 schema 版本赋值，不臆造任何指标
    if (!prepared.schema_version) prepared.schema_version = SCHEMA_VERSION;
    if (!prepared.event_id) prepared.event_id = newId("event");
    if (!prepared.span_id) prepared.span_id = newId("span");
    if (!prepared.trace_id) prepared.trace_id = prepared.span_id;
    if (!prepared.timestamp) prepared.timestamp = nowIsoUtc();

    // 名称哈希（§6.1：工具/插件/模型名可配置脱敏；§3.2：profile 可哈希）
    if (config.hash_names) {
      const salt = ensureSalt();
      if (prepared.tool && typeof prepared.tool.name === "string") {
        prepared.tool = { ...prepared.tool, name: hashName(prepared.tool.name, salt) };
      }
      if (prepared.plugin && typeof prepared.plugin.name === "string") {
        prepared.plugin = { ...prepared.plugin, name: hashName(prepared.plugin.name, salt) };
      }
      if (prepared.model && typeof prepared.model.name === "string") {
        prepared.model = { ...prepared.model, name: hashName(prepared.model.name, salt) };
      }
      if (prepared.session && typeof prepared.session.profile === "string") {
        prepared.session = { ...prepared.session, profile: hashName(prepared.session.profile, salt) };
      }
    }

  // 内容默认不存在；safe 模式下仅附加脱敏后的 metadata
  if (metadata !== undefined && metadata !== null && config.capture_metadata === "safe") {
    const redactor = ensureRedactor();
    const result = redactor.redactMetadata(metadata);
    prepared.metadata = result.value ?? {};
    prepared.privacy = { ...defaultPrivacy(), redactions: result.redactions, rules: result.rules };
  } else {
    prepared.privacy = defaultPrivacy(); // 默认模式也补 privacy 块
  }

    const check = validateEvent(prepared);
    if (!check.ok) {
      return { ok: false, reason: "invalid_event", errors: check.errors };
    }
    return { ok: true, event: prepared };
  }

  /** 订阅适配器事件流（显式接入）。返回解绑函数。 */
  function attach(adapter) {
    if (!adapter || typeof adapter.on !== "function") return () => {};
    return adapter.on("*", (event) => {
      record(event);
    });
  }

  async function flush() {
    if (typeof recorder.sink?.flush === "function") await recorder.sink.flush();
  }

  async function close() {
    if (typeof recorder.sink?.close === "function") await recorder.sink.close();
  }

  function status() {
    // 报告实际生效的后端，而不是只回显配置（sink 尚未构建时退回配置值）
    const effectiveStore = recorder._sinkKind ?? recorder.sink?.kind ?? config.store;
    return {
      enabled: config.enabled,
      store: effectiveStore,
      store_requested: config.store,
      store_effective: effectiveStore,
      store_fallback: recorder._sinkFallback,
      store_fallback_reason: recorder._sinkFallbackReason,
      started: recorder._started,
      counters: { ...recorder.counters },
      capabilities: recorder.capabilities,
      config_summary: {
        // 启动日志只显示已启用能力和存储类型，不打印敏感路径片段（§11）
        enabled: config.enabled,
        store: config.store,
        capture_metadata: config.capture_metadata,
        hash_names: config.hash_names,
        sample_rate: config.sample_rate,
      },
    };
  }

  return {
    record,
    attach,
    start,
    flush,
    close,
    status,
    config,
    get sink() { return recorder.sink; },
    get counters() { return recorder.counters; },
    get capabilities() { return recorder.capabilities; },
  };
}
