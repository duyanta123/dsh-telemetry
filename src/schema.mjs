/**
 * dsh-local-telemetry — 事件契约（schema version 1.0）。
 *
 * 固定 12 种生命周期事件名（计划 §2）；未知指标一律为 null / 缺省，
 * 不允许用 0 伪造（计划 §3.2）。本模块是唯一的 schema 权威：
 * 录制器、sink、store、聚合器都从这里取常量与校验逻辑。
 */
import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = "1.0";
export const SUPPORTED_SCHEMA_MAJOR = 1;

/** 计划 §2 目标事件全集。失败/超时通过 completed 事件的 result.status 表达，不新增事件名。 */
export const EVENT_NAMES = Object.freeze([
  "request.started",
  "request.context",
  "model.requested",
  "model.first_token",
  "model.completed",
  "model.failed",
  "tool.started",
  "tool.completed",
  "plugin.started",
  "plugin.completed",
  "request.completed",
  "request.cancelled",
]);

/** 终止型事件：携带 span 结束语义，录制器据此闭合 span 并计算时长。 */
export const TERMINAL_EVENTS = Object.freeze([
  "model.completed",
  "model.failed",
  "tool.completed",
  "plugin.completed",
  "request.completed",
  "request.cancelled",
]);

export const REQUEST_EVENTS = Object.freeze([
  "request.started",
  "request.context",
  "request.completed",
  "request.cancelled",
]);

export const MODEL_EVENTS = Object.freeze([
  "model.requested",
  "model.first_token",
  "model.completed",
  "model.failed",
]);

export const TOOL_EVENTS = Object.freeze(["tool.started", "tool.completed"]);
export const PLUGIN_EVENTS = Object.freeze(["plugin.started", "plugin.completed"]);

/** result.status 允许值（缺省时由事件名推断：completed=success / failed=failed / cancelled=cancelled）。 */
export const RESULT_STATUSES = Object.freeze(["success", "failed", "timeout", "cancelled"]);

/** 错误分类建议集合（error.kind 自由字符串，聚合按出现值分组）。 */
export const ERROR_KINDS = Object.freeze([
  "timeout",
  "cancelled",
  "rate_limit",
  "auth",
  "network",
  "server",
  "invalid_request",
  "unknown",
]);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function isIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

export function toIsoUtc(ms) {
  return new Date(ms).toISOString();
}

export function nowIsoUtc() {
  return new Date().toISOString();
}

/** 单事件字节上限（计划 §7.2 资源预算）。 */
export const MAX_EVENT_BYTES = 64 * 1024;

const ID_PREFIXES = { event: "evt", span: "span", trace: "trace", request: "req" };

/** 生成 `<prefix>-<12hex>` 形式的不可预测 ID。 */
export function newId(kind) {
  const prefix = ID_PREFIXES[kind] ?? "id";
  const hex = cryptoRandomHex(6);
  return `${prefix}-${hex}`;
}

function cryptoRandomHex(bytes) {
  // node:crypto 的 randomBytes 在所有受支持 Node 版本（≥18）可用；
  // globalThis.crypto 是 Node 19+ 的全局，Node 18 上是 undefined
  return randomBytes(bytes).toString("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkString(errors, event, field, { required = false, allowEmpty = false } = {}) {
  const value = event[field];
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required`);
    return;
  }
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function checkPositiveInt(errors, event, field) {
  const value = event[field];
  if (value === undefined || value === null) return; // 缺失即 null 语义，允许
  if (!Number.isInteger(value) || value < 0) errors.push(`${field} must be a non-negative integer or null`);
}

/**
 * 校验单条事件。返回 { ok, errors, event }；不修改入参。
 * - 缺失的非必填字段按 null 语义处理（不存在 = 未知，与 null 同义）。
 * - schema 主版本不兼容时 ok=false，errors 携带明确原因。
 */
export function validateEvent(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["event must be a JSON object"], event: null };

  const version = input.schema_version;
  if (typeof version !== "string" || version.length === 0) {
    errors.push("schema_version is required");
  } else {
    const major = Number.parseInt(version.split(".")[0], 10);
    if (!Number.isFinite(major) || major !== SUPPORTED_SCHEMA_MAJOR) {
      errors.push(`unsupported schema_version: ${version} (supported major: ${SUPPORTED_SCHEMA_MAJOR})`);
    }
  }

  if (!EVENT_NAMES.includes(input.event)) errors.push(`unknown event name: ${String(input.event)}`);

  for (const field of ["event_id", "trace_id", "span_id"]) {
    checkString(errors, input, field, { required: true });
  }
  checkString(errors, input, "parent_id");
  checkString(errors, input, "request_id");

  if (!isIsoUtc(input.timestamp)) errors.push("timestamp must be ISO 8601 UTC (e.g. 2026-08-23T12:00:00.000Z)");

  checkPositiveInt(errors, input, "duration_ms");

  if (input.session !== undefined && input.session !== null && !isPlainObject(input.session)) {
    errors.push("session must be an object");
  }
  if (input.model !== undefined && input.model !== null) {
    if (!isPlainObject(input.model)) errors.push("model must be an object");
    else checkString(errors, input.model, "name");
  }
  if (input.usage !== undefined && input.usage !== null) {
    if (!isPlainObject(input.usage)) {
      errors.push("usage must be an object");
    } else {
      for (const field of ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens"]) {
        const value = input.usage[field];
        if (value === undefined || value === null) continue;
        if (!Number.isInteger(value) || value < 0) errors.push(`usage.${field} must be a non-negative integer or null`);
      }
    }
  }
  if (input.result !== undefined && input.result !== null) {
    if (!isPlainObject(input.result)) errors.push("result must be an object");
    else if (input.result.status !== undefined && !RESULT_STATUSES.includes(input.result.status)) {
      errors.push(`result.status must be one of ${RESULT_STATUSES.join("|")}`);
    }
  }
  if (input.tool !== undefined && input.tool !== null) {
    if (!isPlainObject(input.tool)) errors.push("tool must be an object");
    else checkString(errors, input.tool, "name", { required: true });
  }
  if (input.plugin !== undefined && input.plugin !== null) {
    if (!isPlainObject(input.plugin)) errors.push("plugin must be an object");
    else checkString(errors, input.plugin, "name", { required: true });
  }
  if (input.error !== undefined && input.error !== null) {
    if (!isPlainObject(input.error)) errors.push("error must be an object");
    else checkString(errors, input.error, "kind", { required: true });
  }
  if (input.sampling !== undefined && input.sampling !== null && !isPlainObject(input.sampling)) {
    errors.push("sampling must be an object");
  }
  if (input.privacy !== undefined && input.privacy !== null) {
    if (!isPlainObject(input.privacy)) errors.push("privacy must be an object");
    else {
      checkPositiveInt(errors, input.privacy, "redactions");
      if (input.privacy.content_captured !== undefined && typeof input.privacy.content_captured !== "boolean") {
        errors.push("privacy.content_captured must be a boolean");
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors, event: input } : { ok: false, errors, event: null };
}

/** 事件序列化：确定性键序不强制，但必须产出单行 JSON。 */
export function serializeEvent(event) {
  return JSON.stringify(event);
}

/** 单行反序列化；坏 JSON 返回 { ok:false }（fail-open，由调用方计数）。 */
export function deserializeEvent(line) {
  try {
    const parsed = JSON.parse(line);
    return { ok: true, event: parsed };
  } catch {
    return { ok: false, event: null };
  }
}

/**
 * 推断事件结果状态：completed → success（除非显式声明），
 * failed → failed，cancelled → cancelled。
 */
export function inferStatus(event) {
  if (event.result?.status) return event.result.status;
  if (event.event === "model.failed") return "failed";
  if (event.event === "request.cancelled") return "cancelled";
  if (event.event === "request.completed" || event.event === "model.completed" || event.event === "tool.completed" || event.event === "plugin.completed") {
    return "success";
  }
  return null;
}

/** 事件按域分类，供录制器与聚合器路由。 */
export function eventDomain(event) {
  const name = typeof event === "string" ? event : event?.event;
  if (REQUEST_EVENTS.includes(name)) return "request";
  if (MODEL_EVENTS.includes(name)) return "model";
  if (TOOL_EVENTS.includes(name)) return "tool";
  if (PLUGIN_EVENTS.includes(name)) return "plugin";
  return "other";
}
