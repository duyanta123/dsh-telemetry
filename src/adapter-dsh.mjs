/**
 * dsh-local-telemetry — DSH（DeepSeek Harness）宿主适配器（计划 §2）。
 *
 * 接入点：宿主在 `@deepseek-ai/dsh-session` 公开声明的 session 事件总线
 * （`session/created` / `session/event` / `session/flush` / `session/disposed`）。
 * 其中 `session/event` 的契约是「post-commit、fire-and-forget 的 append 订阅，
 * 观察者异常被宿主包含」，因此本适配器天然 fail-open，不会影响 agent loop。
 *
 * 为什么不是别的接入点（2026-09 实测 @deepseek-ai/dsh 0.1.5-rc.1）：
 * - `ctx.sessionTelemetry`（SessionTelemetryBackend seam）在 dsh-base 里已被官方
 *   `@deepseek-ai/dsh-session-telemetry-otel` 占用（重复注册会抛错），且该行默认
 *   `mode: FEEDBACK_ONLY` + `capture: "on-demand"`，只有用户显式 feedback 才采集，
 *   不适用于「本地常开」的自我遥测。
 * - `session-telemetry/record` 是**脱敏** waterfall（redaction），且只在上述按需
 *   采集路径上触发；拿它当采集通道既语义不符，也会与官方后端的导出策略耦合。
 * - 因此选公开、常开、无副作用的 session 事件总线；本模块不注册任何服务、
 *   不占用任何 seam、不改变请求语义。
 *
 * 映射口径（计划 §3.1 / §4）：
 *   turn  = 一次用户请求        -> request span（trace 根，request_id = turn-N）
 *   step  = 一次模型调用 attempt -> model span（parent = request）
 *   tool  = 该 attempt 内的工具   -> tool span（parent = model span）
 *   hook  = 命令 hook 的调用      -> plugin span（§4.4 插件/hook 耗时）
 *
 * 隐私（计划 §6）：只取名称、ID、数量、状态、耗时与错误分类；
 * `tool/call.arguments`、`assistant/message.message.content`、`text-chunks.texts`
 * 等内容字段一律**不读出、不落盘**。
 *
 * @module dsh-local-telemetry/adapter-dsh
 */

import { toIsoUtc } from "./schema.mjs";

/** 适配器识别并映射的宿主 session 事件（其余事件按「不关心」跳过，不报错）。 */
export const MAPPED_HOST_EVENTS = Object.freeze([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "assistant/message",
  "assistant/attempt",
  "assistant/chunk",
  "tool/call",
  "tool/result",
  "request/context",
  "request/header",
  "text-chunks",
  "reasoning-chunks",
  "tool-call-chunks",
  "hook/invoked",
  "hook/result",
]);

/** 宿主侧订阅的顶层总线事件。 */
export const HOST_BUS_EVENTS = Object.freeze([
  "session/created",
  "session/event",
  "session/flush",
  "session/disposed",
]);

/**
 * 宿主能力声明：如实标注「我们能看到什么、看不到什么」。
 * - usage_tokens / cache_tokens：confirmed（assistant/message.usage 实测有 input/output/cacheRead）
 * - plugin 生命周期：partial（只能观察命令 hook 的 invoked/result，看不到进程内插件初始化）
 * - cost：仍来自版本化价格目录，不是宿主提供
 */
export function createHostCapabilities(overrides = {}) {
  return {
    lifecycle_hooks: "partial",
    host: "@deepseek-ai/dsh-session",
    bus_events: [...HOST_BUS_EVENTS],
    events: [...MAPPED_HOST_EVENTS],
    usage_tokens: "confirmed",
    cache_tokens: "confirmed",
    reasoning_tokens: "confirmed",
    first_token: "confirmed",
    plugin_lifecycle: "partial",
    cost_model: "catalog",
    ...overrides,
  };
}

/** 归一化失败码：宿主 failure.code / error.name -> 本插件 error.kind。 */
export function normalizeErrorKind(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  const key = value.trim().toLowerCase();
  const known = {
    "rate_limit": "rate_limit",
    "ratelimit": "rate_limit",
    "429": "rate_limit",
    "timeout": "timeout",
    "transport": "transport",
    "server": "server_error",
    "empty_response": "empty_response",
    "unknown_tool": "tool_not_found",
    "toolnotfounderror": "tool_not_found",
    "cancelled": "cancelled",
    "aborted": "cancelled",
    "context_length": "context_limit",
    "invalid_request": "invalid_request",
  };
  if (known[key]) return known[key];
  return key.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

/** 新建一个会话的映射状态（纯内存，随 session/disposed 释放）。 */
export function createSessionState(sessionId, options = {}) {
  return {
    id: String(sessionId ?? "unknown"),
    profile: options.profile ?? null,
    environment: options.environment ?? "local",
    turns: new Map(),
    attempts: new Map(),
    tools: new Map(),
    model: null,
    counters: { events: 0, ignored: 0, incomplete: 0 },
  };
}
// ---------------------------------------------------------------- 内部工具

function attemptKey(turn, step) {
  return turn + "|" + step;
}

function ensureTurn(state, turn, time) {
  let t = state.turns.get(turn);
  if (!t) {
    t = {
      turn,
      startedAt: Number.isFinite(time) ? time : Date.now(),
      spanId: "req-t" + turn,
      traceId: state.id + "#t" + turn,
      requestId: "turn-" + turn,
    };
    state.turns.set(turn, t);
  }
  return t;
}

function latestTurn(state) {
  let last = null;
  for (const t of state.turns.values()) last = t;
  return last;
}

function slotFor(state, turn, step) {
  const key = attemptKey(turn, step);
  let slot = state.attempts.get(key);
  if (!slot) {
    slot = { history: [], current: null };
    state.attempts.set(key, slot);
  }
  return slot;
}

function newAttempt(turn, step, n, time) {
  return {
    n,
    turn,
    step,
    startedAt: Number.isFinite(time) ? time : Date.now(),
    spanId: "mdl-t" + turn + "-s" + step + (n > 1 ? "-a" + n : ""),
    terminal: false,
    firstToken: false,
    minChunkTime: null,
  };
}

/** 取（必要时新建）某 step 的当前 attempt——中途接入会话时也能照实记录。 */
function currentAttempt(state, turn, step, time) {
  const slot = slotFor(state, turn, step);
  if (!slot.current) {
    const attempt = newAttempt(turn, step, slot.history.length + 1, time);
    slot.current = attempt;
    slot.history.push(attempt);
  }
  return slot.current;
}

function base(state, time, fields) {
  const session = { id: state.id, environment: state.environment };
  if (state.profile) session.profile = state.profile;
  return Object.assign({ session, timestamp: toIsoUtc(time) }, fields);
}

function durationOf(time, startedAt) {
  if (!Number.isFinite(time) || !Number.isFinite(startedAt)) return undefined;
  return Math.max(0, Math.round(time - startedAt));
}

/** 只在 name 可用时产出 model 字段——缺失即省略，不臆造模型名。 */
function modelFields(model) {
  if (!model || typeof model.name !== "string" || model.name.length === 0) return undefined;
  const out = { name: model.name };
  if (typeof model.provider === "string" && model.provider.length > 0) out.provider = model.provider;
  return out;
}

/** 从 assistant/message.message.source 取模型归属（kind === 'model'）。 */
function modelFromMessage(message) {
  const source = message && typeof message === "object" ? message.source : null;
  if (!source || typeof source !== "object" || source.kind !== "model") return null;
  if (typeof source.model !== "string" || source.model.length === 0) return null;
  return { provider: source.provider, name: source.model };
}

/** TokenUsage（宿主 camelCase）-> 本插件 schema（snake_case）；无有效字段则省略。 */
function usageFields(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {};
  const map = [
    ["input_tokens", "inputTokens"],
    ["output_tokens", "outputTokens"],
    ["cached_input_tokens", "cacheReadTokens"],
    ["reasoning_tokens", "reasoningTokens"],
  ];
  for (const pair of map) {
    const value = usage[pair[1]];
    if (Number.isInteger(value) && value >= 0) out[pair[0]] = value;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function turnOf(state, turn, time) {
  return ensureTurn(state, turn, time);
}

// ---------------------------------------------------------------- 事件映射

function onTurnStart(state, data, time) {
  const turn = turnOf(state, Number(data.turn), time);
  return [base(state, time, {
    event: "request.started",
    trace_id: turn.traceId,
    span_id: turn.spanId,
    request_id: turn.requestId,
  })];
}

function onTurnEnd(state, data, time) {
  const turnNumber = Number(data.turn);
  const t = turnOf(state, Number.isFinite(turnNumber) ? turnNumber : 0, time);
  const reason = data.reason && typeof data.reason === "object" ? data.reason : {};
  const kind = typeof reason.kind === "string" ? reason.kind : "unknown";
  const fields = {
    trace_id: t.traceId,
    span_id: t.spanId,
    request_id: t.requestId,
    duration_ms: durationOf(time, t.startedAt),
  };
  state.turns.delete(t.turn);

  if (kind === "aborted" || kind === "interrupted" || kind === "crash-orphaned") {
    return [base(state, time, Object.assign(fields, {
      event: "request.cancelled",
      result: { status: "cancelled" },
      error: { kind: "cancelled" },
    }))];
  }
  if (kind === "error") {
    const err = reason.error && typeof reason.error === "object" ? reason.error : {};
    return [base(state, time, Object.assign(fields, {
      event: "request.completed",
      result: { status: "failed" },
      error: { kind: normalizeErrorKind(err.code ?? err.name ?? "error") },
    }))];
  }
  if (kind === "blocked") {
    return [base(state, time, Object.assign(fields, {
      event: "request.completed",
      result: { status: "failed" },
      error: { kind: "blocked" },
    }))];
  }
  // completed / max-tokens / 未知收尾：按成功计（事件名即事实，不额外加工）
  return [base(state, time, Object.assign(fields, {
    event: "request.completed",
    result: { status: "success" },
  }))];
}

function onStepStart(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const slot = slotFor(state, turn, step);
  if (slot.current && !slot.current.terminal) state.counters.incomplete += 1;
  const attempt = newAttempt(turn, step, slot.history.length + 1, time);
  slot.current = attempt;
  slot.history.push(attempt);
  return [base(state, time, {
    event: "model.requested",
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
    model: modelFields(state.model),
  })];
}

function onStreamChunk(state, data, time0, fallbackTime) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, fallbackTime);
  const slot = slotFor(state, turn, step);
  const attempt = slot.current;
  if (!attempt || attempt.terminal || attempt.firstToken) return [];
  const at = Number.isFinite(time0) ? time0 : fallbackTime;
  if (!Number.isFinite(at)) return [];
  // 只记录最小值，等终态回填：压缩 run 的 append 顺序不代表时间顺序
  if (attempt.minChunkTime === null || at < attempt.minChunkTime) attempt.minChunkTime = at;
  return [];
}

/** 原始 chunk（append 顺序 = 时间顺序）：首个即首 token，权威口径。 */
function onAssistantChunk(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const slot = slotFor(state, turn, step);
  const attempt = slot.current;
  if (!attempt || attempt.terminal || attempt.firstToken) return [];
  attempt.firstToken = true;
  return [base(state, time, {
    event: "model.first_token",
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
  })];
}

/** 终态到达时若仍无首 token（老日志只剩压缩 run），用最小 time0 回填。 */
function firstTokenFallback(state, t, attempt) {
  if (!attempt || attempt.firstToken || !Number.isFinite(attempt.minChunkTime)) return [];
  attempt.firstToken = true;
  return [base(state, attempt.minChunkTime, {
    event: "model.first_token",
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
  })];
}

function onAssistantMessage(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const attempt = currentAttempt(state, turn, step, time);
  const model = modelFromMessage(data.message) ?? state.model;
  const usage = usageFields(data.usage);
  const interrupted = data.interrupted === true;
  const out = firstTokenFallback(state, t, attempt);
  attempt.terminal = true;
  const fields = {
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
    duration_ms: durationOf(time, attempt.startedAt),
    model: modelFields(model),
    usage,
    result: { status: interrupted ? "cancelled" : "success" },
  };
  if (interrupted) fields.error = { kind: "cancelled" };
  out.push(base(state, time, Object.assign({ event: "model.completed" }, fields)));
  return out;
}

function onAssistantAttempt(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const attempt = currentAttempt(state, turn, step, time);
  const out = firstTokenFallback(state, t, attempt);
  attempt.terminal = true;
  out.push(base(state, time, {
    event: "model.failed",
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
    duration_ms: durationOf(time, attempt.startedAt),
    model: modelFields(state.model),
    result: { status: "failed" },
    error: { kind: "no_message" },
  }));
  return out;
}

function onLlmRetry(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const slot = slotFor(state, turn, step);
  const out = [];
  const failure = data.failure && typeof data.failure === "object" ? data.failure : {};
  const attempt = slot.current;
  if (attempt && !attempt.terminal) {
    out.push(...firstTokenFallback(state, t, attempt));
    attempt.terminal = true;
    out.push(base(state, time, {
      event: "model.failed",
      trace_id: t.traceId,
      span_id: attempt.spanId,
      parent_id: t.spanId,
      request_id: t.requestId,
      duration_ms: durationOf(time, attempt.startedAt),
      model: modelFields(state.model),
      result: { status: "failed" },
      error: { kind: normalizeErrorKind(failure.code ?? failure.name) },
    }));
  }
  // 重试 = 同一 step 的下一个 model attempt：新 span，让 attempts/retries 与每次延迟都成立
  const next = newAttempt(turn, step, slot.history.length + 1, time);
  slot.current = next;
  slot.history.push(next);
  out.push(base(state, time, {
    event: "model.requested",
    trace_id: t.traceId,
    span_id: next.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
    model: modelFields(state.model),
  }));
  return out;
}

function onStepEnd(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const slot = state.attempts.get(attemptKey(turn, step));
  const attempt = slot && slot.current;
  if (!attempt || attempt.terminal) return [];
  const out = firstTokenFallback(state, t, attempt);
  attempt.terminal = true;
  state.counters.incomplete += 1;
  out.push(base(state, time, {
    event: "model.failed",
    trace_id: t.traceId,
    span_id: attempt.spanId,
    parent_id: t.spanId,
    request_id: t.requestId,
    duration_ms: durationOf(time, attempt.startedAt),
    model: modelFields(state.model),
    result: { status: "failed" },
    error: { kind: "no_completion" },
  }));
  return out;
}
function onToolCall(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const callId = typeof data.callId === "string" && data.callId.length > 0 ? data.callId : null;
  if (!callId) return [];
  const slot = slotFor(state, turn, step);
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : "unknown";
  // 注意：绝不读取 data.arguments（模型产出的原始参数，可能含用户代码/密钥）
  state.tools.set(callId, {
    name,
    startedAt: time,
    spanId: "tool:" + callId,
    parentId: slot.current ? slot.current.spanId : t.spanId,
  });
  return [base(state, time, {
    event: "tool.started",
    trace_id: t.traceId,
    span_id: "tool:" + callId,
    parent_id: slot.current ? slot.current.spanId : t.spanId,
    request_id: t.requestId,
    tool: { name },
  })];
}

function onToolResult(state, data, time) {
  const turn = Number(data.turn);
  const step = Number(data.step);
  const t = turnOf(state, turn, time);
  const message = data.message && typeof data.message === "object" ? data.message : {};
  const source = message.source && typeof message.source === "object" ? message.source : {};
  const callId = typeof source.callId === "string" && source.callId.length > 0 ? source.callId : null;
  if (!callId) return [];
  const known = state.tools.get(callId) ?? null;
  state.tools.delete(callId);
  const block = Array.isArray(message.content) && message.content.length > 0 ? message.content[0] : null;
  const isError = Boolean(block && typeof block === "object" && block.isError === true);
  const detail = data.error && typeof data.error === "object" ? data.error : null;
  const fields = {
    event: "tool.completed",
    trace_id: t.traceId,
    span_id: "tool:" + callId,
    parent_id: known ? known.parentId : t.spanId,
    request_id: t.requestId,
    tool: { name: known ? known.name : "unknown" },
    result: { status: isError ? "failed" : "success" },
  };
  const duration = known ? durationOf(time, known.startedAt) : undefined;
  if (duration !== undefined) fields.duration_ms = duration;
  if (isError) {
    fields.error = { kind: normalizeErrorKind((detail && (detail.name ?? detail.code)) ?? "tool_error") };
  }
  return [base(state, time, fields)];
}

function onHookInvoked(state, data, time) {
  const turn = Number(data.turn);
  const point = typeof data.point === "string" && data.point.length > 0 ? data.point : "unknown";
  const handlerId = typeof data.handlerId === "string" && data.handlerId.length > 0 ? data.handlerId : "unknown";
  const spanId = "hook:t" + turn + ":" + point + ":" + handlerId;
  return [base(state, time, {
    event: "plugin.started",
    trace_id: traceOf(state, turn),
    span_id: spanId,
    parent_id: requestSpanOf(state, turn),
    request_id: "turn-" + turn,
    plugin: { name: handlerId, hook: point },
  })];
}

function onHookResult(state, data, time) {
  const turn = Number(data.turn);
  const point = typeof data.point === "string" && data.point.length > 0 ? data.point : "unknown";
  const handlerId = typeof data.handlerId === "string" && data.handlerId.length > 0 ? data.handlerId : "unknown";
  const spanId = "hook:t" + turn + ":" + point + ":" + handlerId;
  const exitCode = Number.isInteger(data.exitCode) ? data.exitCode : null;
  const decision = typeof data.decision === "string" ? data.decision : null;
  const failed = (exitCode !== null && exitCode !== 0) || decision === "deny" || decision === "block";
  const plugin = { name: handlerId, hook: point };
  if (decision) plugin.decision = decision;
  const fields = {
    event: "plugin.completed",
    trace_id: traceOf(state, turn),
    span_id: spanId,
    parent_id: requestSpanOf(state, turn),
    request_id: "turn-" + turn,
    plugin,
    result: { status: failed ? "failed" : "success" },
  };
  const duration = Number.isInteger(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined;
  if (duration !== undefined) fields.duration_ms = duration;
  if (failed) {
    fields.error = { kind: exitCode !== null && exitCode !== 0 ? "hook_exit_" + exitCode : "hook_denied" };
  }
  return [base(state, time, fields)];
}

function onRequestContext(state, data, time) {
  const model = { provider: data.provider, name: data.model };
  const fields = modelFields(model);
  if (fields) state.model = { provider: model.provider, name: model.name };
  const t = latestTurn(state);
  if (!t) return [];
  const event = {
    event: "request.context",
    trace_id: t.traceId,
    span_id: t.spanId,
    request_id: t.requestId,
    model: fields,
  };
  if (Number.isInteger(data.contextWindow) && data.contextWindow > 0) {
    event.context = { window: data.contextWindow };
  }
  return [base(state, time, event)];
}

/** request/header 只用于刷新模型快照（其 body 含完整 system prompt，绝不读出）。 */
function onRequestHeader(state, data) {
  const header = data.header && typeof data.header === "object" ? data.header : {};
  const config = header.config && typeof header.config === "object" ? header.config : {};
  if (typeof config.model === "string" && config.model.length > 0) {
    state.model = { provider: config.provider, name: config.model };
  }
  return [];
}

function traceOf(state, turn) {
  const t = state.turns.get(turn);
  return t ? t.traceId : state.id + "#t" + turn;
}

function requestSpanOf(state, turn) {
  const t = state.turns.get(turn);
  return t ? t.spanId : undefined;
}

/**
 * 把一个宿主 session 事件映射为零条或多条本插件事件（纯函数，便于单测）。
 * 未知事件类型一律忽略并计数，绝不抛错。
 * @param {object} state createSessionState() 产物
 * @param {object} hostEvent 宿主 SessionEvent（{ type, seq, time, data }）
 * @returns {object[]} 待录制事件（未补 schema_version/event_id，由 recorder 补全）
 */
export function mapSessionEvent(state, hostEvent) {
  if (!state || !hostEvent || typeof hostEvent !== "object") return [];
  const time = Number.isFinite(hostEvent.time) ? hostEvent.time : Date.now();
  const data = hostEvent.data && typeof hostEvent.data === "object" ? hostEvent.data : {};
  state.counters.events += 1;
  switch (hostEvent.type) {
    case "turn/start": return onTurnStart(state, data, time);
    case "turn/end": return onTurnEnd(state, data, time);
    case "step/start": return onStepStart(state, data, time);
    case "step/end": return onStepEnd(state, data, time);
    case "assistant/message": return onAssistantMessage(state, data, time);
    case "assistant/attempt": return onAssistantAttempt(state, data, time);
    case "llm/retry": return onLlmRetry(state, data, time);
    case "tool/call": return onToolCall(state, data, time);
    case "tool/result": return onToolResult(state, data, time);
    case "request/context": return onRequestContext(state, data, time);
    case "request/header": return onRequestHeader(state, data);
    case "assistant/chunk":
      return onAssistantChunk(state, data, time);
    case "text-chunks":
    case "reasoning-chunks":
    case "tool-call-chunks":
      return onStreamChunk(state, data, hostEvent.time0, time);
    case "hook/invoked": return onHookInvoked(state, data, time);
    case "hook/result": return onHookResult(state, data, time);
    default:
      state.counters.ignored += 1;
      return [];
  }
}
// ---------------------------------------------------------------- 适配器

/**
 * 创建 DSH 宿主适配器：把 session 事件总线的流量喂给 recorder。
 *
 * 设计约束：
 * - 只在 ctx 暴露 `on()` 时 attach；宿主不提供该总线时如实抛错，由调用方降级。
 * - ingest 全程 try/catch：任何映射/录制异常都只计数，绝不冒泡到宿主。
 * - 会话状态随 `session/disposed` 释放，避免长驻进程内存增长。
 *
 * @param {object} recorder createRecorder() 产物
 * @param {object} [options] { profile, environment, capabilities }
 */
export function createDshAdapter(recorder, options = {}) {
  const states = new Map();
  const capabilities = createHostCapabilities(options.capabilities);
  const stats = {
    attached: false,
    received: 0,
    mapped: 0,
    recorded: 0,
    ignored: 0,
    sampled_out: 0,
    invalid: 0,
    disabled: 0,
    not_started: 0,
    dropped_sink: 0,
    errors: 0,
    sessions: 0,
    unmapped_types: new Map(),
  };
  let disposers = [];

  function stateFor(session) {
    const id = String((session && session.id) ?? "unknown");
    let state = states.get(id);
    if (!state) {
      state = createSessionState(id, options);
      states.set(id, state);
      stats.sessions += 1;
    }
    return state;
  }

  function flushHint() {
    try {
      const sink = recorder && recorder.sink;
      if (!sink || typeof sink.flush !== "function") return;
      const result = sink.flush();
      if (result && typeof result.then === "function") result.then(undefined, () => {});
    } catch {
      stats.errors += 1;
    }
  }

  /** 接收一条宿主 session 事件（也供测试直接注入）。 */
  function ingest(session, hostEvent) {
    stats.received += 1;
    try {
      const state = stateFor(session);
      const mapped = mapSessionEvent(state, hostEvent);
      if (mapped.length === 0) {
        stats.ignored += 1;
        const type = hostEvent && hostEvent.type ? String(hostEvent.type) : "unknown";
        stats.unmapped_types.set(type, (stats.unmapped_types.get(type) ?? 0) + 1);
        return 0;
      }
      stats.mapped += mapped.length;
      let recorded = 0;
      for (const event of mapped) {
        let outcome = null;
        let threw = false;
        try {
          outcome = recorder.record(event);
        } catch {
          threw = true;
        }
        if (outcome && outcome.ok) {
          recorded += 1;
          stats.recorded += 1;
        } else if (outcome && outcome.reason === "sampled_out") {
          stats.sampled_out += 1;
        } else if (outcome && outcome.reason === "invalid") {
          stats.invalid += 1;
        } else if (outcome && outcome.reason === "disabled") {
          stats.disabled += 1;
        } else if (outcome && outcome.reason === "not_started") {
          stats.not_started += 1;
        } else if (threw || outcome === undefined || outcome === null) {
          // recorder 自身抛错/无返回：属于错误，不能和 sink 拒收混为一谈
          stats.errors += 1;
        } else {
          // sink 侧拒收（队列满/写失败）属于「丢弃」，不是映射错误
          stats.dropped_sink += 1;
        }
      }
      return recorded;
    } catch {
      stats.errors += 1;
      return 0;
    }
  }

  function attach(ctx) {
    if (typeof ctx?.on !== "function") {
      throw new TypeError("dsh adapter requires a cordis-like ctx.on(name, listener)");
    }
    if (stats.attached) return api;
    const bind = (name, listener) => {
      try {
        const dispose = ctx.on(name, listener);
        if (typeof dispose === "function") disposers.push(dispose);
      } catch {
        stats.errors += 1;
      }
    };
    bind("session/created", (session) => {
      try {
        stateFor(session);
      } catch {
        stats.errors += 1;
      }
    });
    bind("session/event", (session, event) => {
      ingest(session, event);
    });
    bind("session/flush", () => {
      flushHint();
    });
    bind("session/disposed", (session) => {
      try {
        states.delete(String((session && session.id) ?? "unknown"));
      } catch {
        stats.errors += 1;
      }
      flushHint();
    });
    stats.attached = true;
    return api;
  }

  function detach() {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        stats.errors += 1;
      }
    }
    disposers = [];
    stats.attached = false;
  }

  function snapshot() {
    const sessions = [];
    for (const state of states.values()) {
      sessions.push({
        id: state.id,
        events: state.counters.events,
        ignored: state.counters.ignored,
        incomplete: state.counters.incomplete,
        open_turns: state.turns.size,
      });
    }
    return {
      attached: stats.attached,
      received: stats.received,
      mapped: stats.mapped,
      recorded: stats.recorded,
      ignored: stats.ignored,
      sampled_out: stats.sampled_out,
      invalid: stats.invalid,
      disabled: stats.disabled,
      not_started: stats.not_started,
      dropped_sink: stats.dropped_sink,
      errors: stats.errors,
      sessions,
      unmapped_types: Object.fromEntries([...stats.unmapped_types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
      capabilities,
    };
  }

  const api = {
    attach,
    detach,
    ingest,
    flush: flushHint,
    getCapabilities: () => capabilities,
    snapshot,
    stats,
    capabilities,
    stateFor,
  };
  return api;
}