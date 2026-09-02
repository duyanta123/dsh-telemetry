/**
 * dsh-local-telemetry — 隐私与脱敏（计划 §6）。
 *
 * 原则：内容字段默认不存在（不是采集后再脱敏）；仅当 capture_metadata="safe"
 * 时才对可选 metadata 执行脱敏，且只保留规则名与命中数量，不保存原文。
 * 名称哈希使用数据目录内随机 salt（SHA-256 截断），稳定但不可直接还原。
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 内置敏感字段名（计划 §6.2）。metadata 的键命中即整体丢弃该键。 */
export const SECRET_FIELDS = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "private_key",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
]);

const SECRET_FIELDS_RE = new RegExp(`^(${SECRET_FIELDS.map((f) => f.replace(/[-]/g, "\\-")).join("|")})$`, "i");

/** 字符串内嵌的 `字段名: 值` / `字段名=值` 形态（含 header、query 风格）。 */
const INLINE_SECRET_RE = new RegExp(
  `\\b(${SECRET_FIELDS.map((f) => f.replace(/-/g, "[-_]?")).join("|")})\\b\\s*[:=]\\s*["']?([A-Za-z0-9._~+/=\\-]{4,})["']?`,
  "gi"
);

const BEARER_RE = /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=\-]{6,}/gi;
/** URL userinfo 凭据：scheme://user:pass@host / scheme://token@host。 */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)?:([^\s/@]+)@/gi;
const URL_USERINFO_TOKEN_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(ghp_[A-Za-z0-9]+|[A-Za-z0-9]{20,})@/gi;
/** URL query 中的敏感参数值。 */
const URL_QUERY_SECRET_RE = /([?&#](?:token|access_token|refresh_token|api_key|apikey|secret|password|sig|signature|client_secret|session_id)=)[^\s&"#]+/gi;
/** 绝对路径：Windows 盘符路径与常见 Unix 前缀。 */
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\[^\s"',:;)]+(?:\\[^\s"',:;)]*)*)|(?:\/(?:home|Users|root|var|tmp|etc|opt|mnt|srv)\/[^\s"',:;)]+)/g;

/**
 * 创建脱敏器。
 * @param {object} opts
 * @param {Array<{name:string, regex:RegExp}>} opts.customRules  用户自定义规则
 * @param {"basename"|"hash"|null} [opts.absolutePaths] 绝对路径处理策略（默认 basename）
 * @param {string} [opts.salt] 名称哈希 salt；未提供时 hashName 抛错前会给出明确提示
 */
export function createRedactor({ customRules = [], absolutePaths = "basename", salt = null } = {}) {
  const stats = new Map(); // ruleName -> count

  function hit(rule) {
    stats.set(rule, (stats.get(rule) ?? 0) + 1);
  }

  function redactAbsolutePath(value) {
    return value.replace(ABSOLUTE_PATH_RE, (match) => {
      hit("absolute_path");
      if (absolutePaths === "hash" && salt) return hashName(match, salt);
      const normalized = match.replace(/\\+/g, "/");
      const base = normalized.split("/").filter(Boolean).pop() ?? match;
      return base;
    });
  }

  /** 对单个字符串执行全部内置 + 自定义规则。 */
  function redactString(value) {
    if (typeof value !== "string" || value.length === 0) return value;
    let out = value;
    for (const rule of customRules) {
      out = out.replace(rule.regex, () => {
        hit(rule.name);
        return `[redacted:${rule.name}]`;
      });
    }
    out = out.replace(URL_USERINFO_RE, (_m, scheme) => {
      hit("url_credentials");
      return `${scheme}[redacted:url_credentials]@`;
    });
    out = out.replace(URL_USERINFO_TOKEN_RE, (_m, scheme) => {
      hit("url_credentials");
      return `${scheme}[redacted:url_credentials]@`;
    });
    out = out.replace(URL_QUERY_SECRET_RE, (_m, prefix) => {
      hit("url_query_token");
      return `${prefix}[redacted:url_query_token]`;
    });
    out = out.replace(BEARER_RE, () => {
      hit("authorization");
      return "[redacted:authorization]";
    });
    out = out.replace(INLINE_SECRET_RE, (_m, field) => {
      const name = String(field).toLowerCase().replace(/[-_]?key$/, "_key").replace(/-/g, "_");
      hit(name);
      return `${field}=[redacted:${name}]`;
    });
    if (absolutePaths) out = redactAbsolutePath(out);
    return out;
  }

  /**
   * 对可选 metadata 对象脱敏：敏感键整体丢弃；字符串值走 redactString；
   * 数字/布尔保留（大小、计数类安全信息）。返回 { value, redactions, rules }。
   */
  function redactMetadata(metadata) {
    if (metadata === null || metadata === undefined) return { value: null, redactions: 0, rules: [] };
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return { value: null, redactions: 0, rules: [] };
    }
    const before = new Map(stats);
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (SECRET_FIELDS_RE.test(key)) {
        hit(key.toLowerCase().replace(/-/g, "_"));
        continue; // 整键丢弃，不保留占位值
      }
      if (typeof value === "string") {
        out[key] = redactString(value);
      } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
        out[key] = value;
      } else {
        // 嵌套结构不递归展开：只保留安全原语，防内容夹带
        hit("nested_metadata_dropped");
      }
    }
    // 仅统计本次调用命中的规则
    const rules = [];
    let redactions = 0;
    for (const [name, count] of stats.entries()) {
      const delta = count - (before.get(name) ?? 0);
      if (delta > 0) {
        redactions += delta;
        rules.push(name);
      }
    }
    return { value: out, redactions, rules };
  }

  function totalHits() {
    let sum = 0;
    for (const count of stats.values()) sum += count;
    return sum;
  }

  function summarize(before, value) {
    const redactions = totalHits() - before;
    const rules = [];
    for (const [name, count] of stats.entries()) {
      if (count > 0) rules.push(name);
    }
    return { value, redactions, rules };
  }

  /** 汇总自创建以来的命中（用于 privacy 块）。 */
  function summary() {
    return { redactions: totalHits(), rules: [...new Set(stats.keys())].filter((k) => (stats.get(k) ?? 0) > 0) };
  }

  function statsSnapshot() {
    return Object.fromEntries(stats.entries());
  }

  return { redactString, redactMetadata, summary, statsSnapshot };
}

/**
 * 名称哈希：SHA-256(salt + name) 截断 16 hex，加 `h:` 前缀。
 * 稳定（同 salt 同名同结果），不可直接还原。
 */
export function hashName(name, salt) {
  if (typeof name !== "string" || name.length === 0) return name;
  return `h:${createHash("sha256").update(`${salt}\u0000${name}`).digest("hex").slice(0, 16)}`;
}

/**
 * 获取或创建数据目录内的哈希 salt（`.salt` 文件，32 hex）。
 * 目录不存在时惰性创建。创建失败返回进程内临时 salt（稳定性降级，可用性优先）。
 */
export function getOrCreateSalt(dataDir) {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const saltPath = join(dataDir, ".salt");
    if (existsSync(saltPath)) {
      const existing = readFileSync(saltPath, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(existing)) return existing;
    }
    const salt = randomBytes(16).toString("hex");
    writeFileSync(saltPath, `${salt}\n`, { mode: 0o600 });
    return salt;
  } catch {
    return randomBytes(16).toString("hex");
  }
}

/** 事件级 privacy 块默认值：内容未采集，无脱敏命中。 */
export function defaultPrivacy() {
  return { content_captured: false, redactions: 0, rules: [] };
}
