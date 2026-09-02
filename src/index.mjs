/**
 * dsh-local-telemetry — 公共库接口（exports 子路径 `dsh-local-telemetry/telemetry`）。
 *
 * 上层插件（dsh-change-impact / dsh-test-insight 等）与宿主集成代码从这里
 * 引入；插件入口（plugin/index.js）只负责 skills 注册与关闭时 flush。
 */

export { SCHEMA_VERSION, EVENT_NAMES, TERMINAL_EVENTS, validateEvent, serializeEvent, deserializeEvent, newId, nowIsoUtc, toIsoUtc, MAX_EVENT_BYTES } from "./schema.mjs";
export { DEFAULT_CONFIG, BUDGET_LIMITS, resolveConfig, loadConfigFile, parseDurationOrTimestamp, sinceUntilRange, resolveDataPath } from "./config.mjs";
export { createRedactor, hashName, getOrCreateSalt, defaultPrivacy, SECRET_FIELDS } from "./privacy.mjs";
export { createSampler, SAMPLING_STRATEGY } from "./sampling.mjs";
export { createEventBusAdapter, createCapabilities, detectCapabilities } from "./adapter.mjs";
export { createRecorder } from "./recorder.mjs";
export { JsonlSink, utcDateOf } from "./sink-jsonl.mjs";
export { createSqliteSink, sqliteAvailable, isSqliteSupported } from "./sink-sqlite.mjs";
export { openStore, createJsonlStore, createSqliteStore, matchesFilters, isFailureEvent } from "./store.mjs";
export { aggregateEvents, aggregateGrouped, pairSpans, slowTraceIds, buildTraceView, listRequestRows, percentile } from "./aggregate.mjs";
export { loadPriceCatalog, computeCost, sumCosts } from "./cost.mjs";
export { renderTextSummary, renderMarkdownReport, renderTraceText, renderGroupedText } from "./report.mjs";
export { createTelemetryServer } from "./server.mjs";
