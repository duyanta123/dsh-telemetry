/**
 * dsh-local-telemetry — 配置解析（计划 §11）。
 *
 * 规则：
 * - 解析失败 → 采用「关闭」这一安全默认，不猜测用户意图；
 * - 未知键忽略（前向兼容），类型错误逐条记录；
 * - 环境变量不参与配置（密钥不属于遥测配置）。
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  store: "jsonl", // jsonl | sqlite
  path: "~/.dsh/telemetry",
  sample_rate: 1, // 0..1，按 trace 整体采样
  errors_always_sample: true,
  slow_request_ms: 10000,
  capture_metadata: "none", // none | safe
  hash_names: false,
  retention_days: 7,
  max_file_mb: 100,
  flush_interval_ms: 1000,
  batch_size: 100,
  max_queue_events: 1000,
  price_catalog: null, // 版本化价格目录 JSON 路径
  redact_rules: [], // 用户自定义正则（source 字符串），只保留规则名计数
});

/** 资源预算（计划 §7.2）——作为上限参与校准，配置不能超出这些硬上限。 */
export const BUDGET_LIMITS = Object.freeze({
  max_event_bytes: 64 * 1024,
  max_queue_events: 1000,
  max_batch_size: 1000,
  min_flush_interval_ms: 50,
});

export function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  return p;
}

export function resolveDataPath(p, cwd = process.cwd()) {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * 解析时长：`500ms` / `10s` / `30m` / `1h` / `7d` / `30d` → 毫秒；
 * 也接受 ISO 8601 时间戳或 epoch 毫秒数（返回绝对毫秒，relative=false）。
 */
export function parseDurationOrTimestamp(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return { absolute: value, relative: false };
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const rel = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (rel) {
    const n = Number.parseFloat(rel[1]);
    const unit = rel[2];
    const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return { absolute: Math.round(n * mult), relative: true };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    const t = Date.parse(trimmed.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`);
    if (Number.isFinite(t)) return { absolute: t, relative: false };
    return null;
  }
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return { absolute: n < 10_000_000_000 ? n * 1000 : n, relative: false };
  }
  return null;
}

/** 计算 --since / --until 的绝对毫秒边界。 */
export function sinceUntilRange(since, until, now = Date.now()) {
  const s = parseDurationOrTimestamp(since, now);
  const u = parseDurationOrTimestamp(until, now);
  const from = s ? (s.relative ? now - s.absolute : s.absolute) : null;
  const to = u ? (u.relative ? now - u.absolute : u.absolute) : null;
  return { from, to };
}

function checkType(errors, config, key, type) {
  const value = config[key];
  if (value === undefined || value === null) return;
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (actual !== type) {
    errors.push(`${key} must be ${type}, got ${actual}`);
    config[key] = DEFAULT_CONFIG[key]; // 回退安全默认而不是留空
  }
}

/**
 * 合并默认值 + 文件配置 + CLI 覆盖，产出冻结后的有效配置。
 * 任何类型错误不中止：剔除坏键、记录原因，保持安全默认。
 */
export function resolveConfig({ file, overrides } = {}) {
  const errors = [];
  let fileConfig = {};
  if (file) {
    if (typeof file === "string") {
      try {
        fileConfig = JSON.parse(readFileSync(file, "utf8"));
        if (fileConfig === null || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
          errors.push("config file must contain a JSON object");
          fileConfig = {};
        }
      } catch (error) {
        errors.push(`config file unreadable (${error.code ?? error.message})`);
        fileConfig = {};
      }
    } else if (typeof file === "object") {
      fileConfig = file;
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...fileConfig, ...(overrides ?? {}) };
  for (const key of Object.keys(merged)) {
    if (!(key in DEFAULT_CONFIG)) delete merged[key]; // 未知键忽略
  }

  checkType(errors, merged, "enabled", "boolean");
  checkType(errors, merged, "store", "string");
  checkType(errors, merged, "path", "string");
  checkType(errors, merged, "hash_names", "boolean");
  checkType(errors, merged, "errors_always_sample", "boolean");
  checkType(errors, merged, "slow_request_ms", "number");
  checkType(errors, merged, "retention_days", "number");
  checkType(errors, merged, "max_file_mb", "number");
  checkType(errors, merged, "flush_interval_ms", "number");
  checkType(errors, merged, "batch_size", "number");
  checkType(errors, merged, "max_queue_events", "number");
  checkType(errors, merged, "price_catalog", "string");
  checkType(errors, merged, "sample_rate", "number");
  checkType(errors, merged, "capture_metadata", "string");
  checkType(errors, merged, "redact_rules", "array");

  if (!["jsonl", "sqlite"].includes(merged.store)) {
    errors.push(`store must be "jsonl" or "sqlite", got ${JSON.stringify(merged.store)}`);
    merged.store = DEFAULT_CONFIG.store;
  }
  if (!["none", "safe"].includes(merged.capture_metadata)) {
    errors.push(`capture_metadata must be "none" or "safe", got ${JSON.stringify(merged.capture_metadata)}`);
    merged.capture_metadata = "none";
  }
  if (typeof merged.sample_rate === "number") {
    if (!Number.isFinite(merged.sample_rate) || merged.sample_rate < 0 || merged.sample_rate > 1) {
      errors.push(`sample_rate must be within [0,1], got ${merged.sample_rate}`);
      merged.sample_rate = DEFAULT_CONFIG.sample_rate;
    }
  }
  for (const key of ["slow_request_ms", "retention_days", "max_file_mb", "flush_interval_ms", "batch_size", "max_queue_events"]) {
    if (typeof merged[key] === "number" && (!Number.isFinite(merged[key]) || merged[key] < 0)) {
      errors.push(`${key} must be a non-negative number`);
      merged[key] = DEFAULT_CONFIG[key];
    }
  }
  // 硬预算上限（§7.2）：配置超出时钳制并记录
  merged.batch_size = Math.min(Math.round(merged.batch_size), BUDGET_LIMITS.max_batch_size);
  merged.max_queue_events = Math.min(Math.round(merged.max_queue_events), BUDGET_LIMITS.max_queue_events);
  merged.flush_interval_ms = Math.max(Math.round(merged.flush_interval_ms), BUDGET_LIMITS.min_flush_interval_ms);
  if (Array.isArray(merged.redact_rules)) {
    merged.redact_rules = merged.redact_rules
      .filter((rule) => rule && typeof rule === "object" && typeof rule.name === "string" && typeof rule.pattern === "string")
      .map((rule) => {
        try {
          return { name: rule.name, regex: new RegExp(rule.pattern) };
        } catch {
          errors.push(`redact_rules: invalid pattern for ${rule.name}`);
          return null;
        }
      })
      .filter(Boolean);
  }

  return { ok: errors.length === 0, errors, config: Object.freeze(merged) };
}

/** 读取 --config 指定的文件；文件不存在/损坏时按「关闭」这一安全默认处理。 */
export function loadConfigFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, errors: [`config file unreadable (${error.code ?? error.message})`], config: { ...DEFAULT_CONFIG, enabled: false } };
  }
  const result = resolveConfig({ file: raw ? path : null });
  if (!result.ok && result.config) {
    // 解析失败 → 关闭（安全默认），保留错误说明
    return { ok: false, errors: result.errors, config: { ...result.config, enabled: false } };
  }
  return result;
}
