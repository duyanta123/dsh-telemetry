/**
 * dsh-local-telemetry — 聚合器（计划 §4 / Phase 2）。
 *
 * 只从真实事件推导：started/completed 按 span_id 配对得时长（缺失端点则
 * null，绝不臆造）；未知指标为 null 不补 0；所有样本数与分位数方法
 * （nearest-rank）随摘要输出，保证可由原始事件重算（Phase 2 验收）。
 */

import { computeCost, sumCosts } from "./cost.mjs";

/** nearest-rank 分位数：sorted 已升序；n=0 → null。方法固定并写入文档。 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const n = sorted.length;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sorted[index];
}

function ms(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function isFailureStatus(status) {
  return status === "failed" || status === "timeout";
}

function eventTs(event) {
  const t = Date.parse(event.timestamp ?? "");
  return Number.isFinite(t) ? t : null;
}

/**
 * started/completed 通用配对：优先 span_id 精确配对；
 * 兜底在同 trace 内与「最近的未闭合同名 started」配对（宿主不保证 span 传播时）。
 * 返回 { pairs: [{start, end}], unmatched: [started...] }
 */
export function pairSpans(events, { startedName, endNames, nameOf }) {
  const open = new Map(); // span_id -> start event
  const openByNameTrace = new Map(); // `${trace}\u0000${name}` -> [start events]
  const pairs = [];
  const unmatched = [];
  const sorted = [...events].sort((a, b) => (eventTs(a) ?? 0) - (eventTs(b) ?? 0));

  for (const event of sorted) {
    if (event.event === startedName) {
      open.set(event.span_id, event);
      if (nameOf) {
        const key = `${event.trace_id ?? ""}\u0000${nameOf(event)}`;
        if (!openByNameTrace.has(key)) openByNameTrace.set(key, []);
        openByNameTrace.get(key).push(event);
      }
      continue;
    }
    if (!endNames.includes(event.event)) continue;
    let start = open.get(event.span_id) ?? null;
    if (start) {
      open.delete(event.span_id);
      if (nameOf) {
        const key = `${start.trace_id ?? ""}\u0000${nameOf(start)}`;
        const list = openByNameTrace.get(key);
        if (list) {
          const idx = list.indexOf(start);
          if (idx >= 0) list.splice(idx, 1);
        }
      }
    } else if (nameOf) {
      const key = `${event.trace_id ?? ""}\u0000${nameOf(event)}`;
      const list = openByNameTrace.get(key);
      start = list?.shift() ?? null;
    }
    if (start) pairs.push({ start, end: event });
    else unmatched.push(event);
  }
  for (const list of openByNameTrace.values()) unmatched.push(...list);
  return { pairs, unmatched };
}

function spanDuration(pair) {
  if (Number.isInteger(pair.end.duration_ms)) return pair.end.duration_ms;
  const startTs = eventTs(pair.start);
  const endTs = eventTs(pair.end);
  if (startTs === null || endTs === null) return null;
  return Math.max(0, endTs - startTs);
}

/** status 推断：completed 事件显式 status 优先，failed/cancelled 按事件名。 */
function endStatus(end) {
  if (end.result?.status) return end.result.status;
  if (end.event === "model.failed") return "failed";
  if (end.event === "request.cancelled") return "cancelled";
  return "success";
}

function emptyPercentiles() {
  return { p50: null, p95: null, p99: null, avg: null, n: 0 };
}

function durationStats(values) {
  const valid = values.filter((v) => Number.isFinite(v) && v >= 0).map(Math.round).sort((a, b) => a - b);
  if (valid.length === 0) return emptyPercentiles();
  const sum = valid.reduce((acc, v) => acc + v, 0);
  return { p50: percentile(valid, 50), p95: percentile(valid, 95), p99: percentile(valid, 99), avg: Math.round(sum / valid.length), n: valid.length };
}

/**
 * 主聚合入口。events 已经过时间/维度过滤。
 * @param {Array} events
 * @param {object} opts
 * @param {object|null} [opts.catalog] 版本化价格目录（loadPriceCatalog 结果）
 * @param {string|null} [opts.catalogPath] 价格目录路径（仅用于来源标注）
 * @param {string} [opts.generatedAt] 摘要生成时间
 */
export function aggregateEvents(events, { catalog = null, catalogPath = null, generatedAt = null } = {}) {
  const generated = generatedAt ?? new Date().toISOString();
  const sorted = [...events].sort((a, b) => (eventTs(a) ?? 0) - (eventTs(b) ?? 0));

  // ---------- 请求级 ----------
  const byTrace = new Map();
  for (const event of sorted) {
    const trace = event.trace_id ?? event.span_id;
    if (!byTrace.has(trace)) byTrace.set(trace, []);
    byTrace.get(trace).push(event);
  }

  const requests = [];
  for (const [trace, traceEvents] of byTrace) {
    const started = traceEvents.find((e) => e.event === "request.started");
    const terminal = traceEvents.find((e) => e.event === "request.completed" || e.event === "request.cancelled");
    if (!started && !terminal) continue; // 非 request 根 trace（如孤立工具 trace）
    const status = terminal ? endStatus(terminal) : "incomplete";
    let durationMs = null;
    if (Number.isInteger(terminal?.duration_ms)) durationMs = terminal.duration_ms;
    else {
      const startTs = started ? eventTs(started) : null;
      const endTs = terminal ? eventTs(terminal) : null;
      if (startTs !== null && endTs !== null) durationMs = Math.max(0, endTs - startTs);
    }

    const firstRequested = traceEvents.find((e) => e.event === "model.requested");
    let queueMs = null;
    if (started && firstRequested) {
      const s = eventTs(started);
      const r = eventTs(firstRequested);
      if (s !== null && r !== null) queueMs = Math.max(0, r - s);
    }

    const attemptEvents = traceEvents.filter((e) => e.event === "model.requested");
    const attempts = attemptEvents.length;
    const retries = attempts > 1 ? attempts - 1 : 0;
    let fallbacks = 0;
    for (let i = 1; i < attemptEvents.length; i += 1) {
      const prev = attemptEvents[i - 1]?.model?.name;
      const curr = attemptEvents[i]?.model?.name;
      if (prev && curr && prev !== curr) fallbacks += 1;
    }
    const firstToken = traceEvents.find((e) => e.event === "model.first_token");
    let ttftMs = null;
    if (firstToken && firstRequested) {
      const r = eventTs(firstRequested);
      const t = eventTs(firstToken);
      if (r !== null && t !== null) ttftMs = Math.max(0, t - r);
    }
    requests.push({
      trace_id: trace,
      request_id: started?.request_id ?? terminal?.request_id ?? null,
      profile: started?.session?.profile ?? terminal?.session?.profile ?? null,
      status,
      duration_ms: ms(durationMs),
      queue_ms: ms(queueMs),
      ttft_ms: ms(ttftMs),
      model_attempts: attempts,
      retries,
      fallbacks,
    });
  }

  const requestDurations = requests.map((r) => r.duration_ms).filter((v) => v !== null);
  const queueValues = requests.map((r) => r.queue_ms).filter((v) => v !== null);
  const ttftValues = requests.map((r) => r.ttft_ms).filter((v) => v !== null);
  const successCount = requests.filter((r) => r.status === "success").length;
  const failedCount = requests.filter((r) => r.status === "failed" || r.status === "timeout").length;
  const cancelledCount = requests.filter((r) => r.status === "cancelled").length;

  // ---------- 模型级 ----------
  const modelPairs = pairSpans(sorted, {
    startedName: "model.requested",
    endNames: ["model.completed", "model.failed"],
    nameOf: (e) => `${e.model?.provider ?? ""}/${e.model?.name ?? ""}/${e.model?.request_type ?? ""}`,
  });

  const modelMap = new Map();
  const modelCostResults = [];
  for (const pair of modelPairs.pairs) {
    const key = `${pair.start.model?.provider ?? "unknown"}\u0000${pair.start.model?.name ?? "unknown"}\u0000${pair.start.model?.request_type ?? "chat"}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        provider: pair.start.model?.provider ?? null,
        name: pair.start.model?.name ?? null,
        request_type: pair.start.model?.request_type ?? null,
        attempts: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        durations: [],
        ttfts: [],
        tokens: { input: 0, output: 0, cached: 0, known: 0 },
        retries: 0,
        error_kinds: {},
        cost_results: [],
      });
    }
    const bucket = modelMap.get(key);
    bucket.attempts += 1;
    const status = endStatus(pair.end);
    if (status === "success") bucket.success += 1;
    else if (status === "timeout") bucket.timeout += 1;
    else if (status === "cancelled") bucket.cancelled += 1;
    else bucket.failed += 1;
    const kind = pair.end.error?.kind;
    if (kind) bucket.error_kinds[kind] = (bucket.error_kinds[kind] ?? 0) + 1;

    const duration = spanDuration(pair);
    if (duration !== null) bucket.durations.push(duration);

    const firstToken = sorted.find((e) => e.event === "model.first_token" && e.span_id === pair.start.span_id);
    if (firstToken) {
      const r = eventTs(pair.start);
      const t = eventTs(firstToken);
      if (r !== null && t !== null) bucket.ttfts.push(Math.max(0, t - r));
    }
    const usage = pair.end.usage;
    if (usage && (Number.isInteger(usage.input_tokens) || Number.isInteger(usage.output_tokens))) {
      bucket.tokens.known += 1;
      bucket.tokens.input += Number.isInteger(usage.input_tokens) ? usage.input_tokens : 0;
      bucket.tokens.output += Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0;
      bucket.tokens.cached += Number.isInteger(usage.cached_input_tokens) ? usage.cached_input_tokens : 0;
    }
    const cost = computeCost({ model: pair.end.model ?? pair.start.model, usage: pair.end.usage, catalog });
    bucket.cost_results.push(cost);
    modelCostResults.push(cost);
  }
  // 未闭合 attempt（cancelled 请求中的悬挂调用）
  for (const orphan of modelPairs.unmatched) {
    const key = `${orphan.model?.provider ?? "unknown"}\u0000${orphan.model?.name ?? "unknown"}\u0000${orphan.model?.request_type ?? "chat"}`;
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        provider: orphan.model?.provider ?? null,
        name: orphan.model?.name ?? null,
        request_type: orphan.model?.request_type ?? null,
        attempts: 0, success: 0, failed: 0, timeout: 0, cancelled: 0,
        durations: [], ttfts: [], tokens: { input: 0, output: 0, cached: 0, known: 0 }, retries: 0, error_kinds: {}, cost_results: [],
      });
    }
    const bucket = modelMap.get(key);
    bucket.attempts += 1;
    bucket.cancelled += 1; // 请求被取消时未闭合的 attempt 计为 cancelled
  }
  // 重试归属：trace 内同模型多次 attempt
  for (const [trace, traceEvents] of byTrace) {
    const perModel = new Map();
    for (const event of traceEvents) {
      if (event.event !== "model.requested") continue;
      const key = `${event.model?.provider ?? ""}\u0000${event.model?.name ?? ""}`;
      perModel.set(key, (perModel.get(key) ?? 0) + 1);
    }
    for (const [key, count] of perModel) {
      if (count <= 1) continue;
      const bucket = modelMap.get(`${key}\u0000${traceEvents.find((e) => e.event === "model.requested")?.model?.request_type ?? "chat"}`);
      if (bucket) bucket.retries += count - 1;
    }
  }

  const models = [...modelMap.values()].map((bucket) => {
    const costSummary = sumCosts(bucket.cost_results);
    const attempts = bucket.attempts;
    return {
      provider: bucket.provider,
      name: bucket.name,
      request_type: bucket.request_type,
      attempts,
      success: bucket.success,
      failed: bucket.failed,
      timeout: bucket.timeout,
      cancelled: bucket.cancelled,
      success_rate: attempts > 0 ? round4(bucket.success / attempts) : null,
      latency: durationStats(bucket.durations),
      ttft: durationStats(bucket.ttfts),
      tokens: {
        input: bucket.tokens.input,
        output: bucket.tokens.output,
        cached: bucket.tokens.cached,
        events_with_usage: bucket.tokens.known,
      },
      retries: bucket.retries,
      error_kinds: bucket.error_kinds,
      cost: {
        amount: costSummary.amount,
        priced_events: costSummary.priced_events,
        missing: costSummary.missing,
      },
    };
  }).sort((a, b) => b.attempts - a.attempts);

  // ---------- Token 总量 ----------
  let tokens = { input: 0, output: 0, cached: 0, events_with_usage: 0 };
  for (const event of sorted) {
    if (event.event !== "model.completed") continue;
    const usage = event.usage;
    if (usage && (Number.isInteger(usage.input_tokens) || Number.isInteger(usage.output_tokens))) {
      tokens.events_with_usage += 1;
      tokens.input += Number.isInteger(usage.input_tokens) ? usage.input_tokens : 0;
      tokens.output += Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0;
      tokens.cached += Number.isInteger(usage.cached_input_tokens) ? usage.cached_input_tokens : 0;
    }
  }

  // ---------- 成本 ----------
  const costSummary = sumCosts(modelCostResults);

  // ---------- 工具级 ----------
  const toolPairs = pairSpans(sorted, { startedName: "tool.started", endNames: ["tool.completed"], nameOf: (e) => e.tool?.name ?? "unknown" });
  const toolMap = new Map();
  const toolLoops = new Map(); // trace -> Map(tool -> count)
  for (const event of sorted) {
    if (event.event !== "tool.started") continue;
    const trace = event.trace_id ?? "";
    const name = event.tool?.name ?? "unknown";
    if (!toolLoops.has(trace)) toolLoops.set(trace, new Map());
    const perTool = toolLoops.get(trace);
    perTool.set(name, (perTool.get(name) ?? 0) + 1);
  }
  for (const pair of toolPairs.pairs) {
    const name = pair.start.tool?.name ?? "unknown";
    if (!toolMap.has(name)) {
      toolMap.set(name, {
        name, calls: 0, success: 0, failed: 0, timeout: 0, durations: [], confirm_required: 0,
        input_bytes: null, output_bytes: null,
      });
    }
    const bucket = toolMap.get(name);
    bucket.calls += 1;
    const status = endStatus(pair.end);
    if (status === "success") bucket.success += 1;
    else if (status === "timeout") bucket.timeout += 1;
    else bucket.failed += 1;
    const duration = spanDuration(pair);
    if (duration !== null) bucket.durations.push(duration);
    const metadata = pair.end.metadata ?? pair.start.metadata;
    if (metadata && typeof metadata === "object") {
      if (metadata.confirm_required === true) bucket.confirm_required += 1;
      if (Number.isFinite(metadata.input_bytes)) bucket.input_bytes = Math.max(bucket.input_bytes ?? 0, Math.round(metadata.input_bytes));
      if (Number.isFinite(metadata.output_bytes)) bucket.output_bytes = Math.max(bucket.output_bytes ?? 0, Math.round(metadata.output_bytes));
    }
  }
  const tools = [...toolMap.values()].map((bucket) => {
    const stats = durationStats(bucket.durations);
    return {
      name: bucket.name,
      calls: bucket.calls,
      unclosed: 0,
      success: bucket.success,
      failed: bucket.failed,
      timeout: bucket.timeout,
      latency: stats,
      confirm_required: bucket.confirm_required,
      max_input_bytes: bucket.input_bytes,
      max_output_bytes: bucket.output_bytes,
    };
  }).sort((a, b) => b.calls - a.calls);
  // 循环调用提示：同 trace 内同名工具调用 ≥ 3 次
  let loopHints = [];
  for (const [trace, perTool] of toolLoops) {
    for (const [name, count] of perTool) {
      if (count >= 3) loopHints.push({ trace_id: trace, tool: name, calls: count });
    }
  }
  loopHints = loopHints.sort((a, b) => b.calls - a.calls).slice(0, 20);
  for (const tool of tools) {
    tool.unclosed = toolPairs.unmatched.filter((e) => (e.tool?.name ?? "unknown") === tool.name).length;
  }

  // ---------- 插件级 ----------
  const pluginPairs = pairSpans(sorted, { startedName: "plugin.started", endNames: ["plugin.completed"], nameOf: (e) => `${e.plugin?.name ?? "unknown"}\u0000${e.plugin?.hook ?? ""}` });
  const pluginMap = new Map();
  for (const pair of pluginPairs.pairs) {
    const name = pair.start.plugin?.name ?? "unknown";
    const hook = pair.start.plugin?.hook ?? null;
    if (!pluginMap.has(name)) {
      pluginMap.set(name, {
        name, hooks: {}, durations: [], errors: 0, error_kinds: {}, timeout: 0, cancelled: 0,
        metadata_changed: 0,
      });
    }
    const bucket = pluginMap.get(name);
    if (hook) {
      if (!bucket.hooks[hook]) bucket.hooks[hook] = { calls: 0, durations: [], errors: 0 };
      bucket.hooks[hook].calls += 1;
      const duration = spanDuration(pair);
      if (duration !== null) {
        bucket.hooks[hook].durations.push(duration);
        bucket.durations.push(duration);
      }
    } else {
      const duration = spanDuration(pair);
      if (duration !== null) bucket.durations.push(duration);
    }
    const status = endStatus(pair.end);
    if (status === "failed") {
      bucket.errors += 1;
      if (hook) bucket.hooks[hook].errors += 1;
      const kind = pair.end.error?.kind ?? "unknown";
      bucket.error_kinds[kind] = (bucket.error_kinds[kind] ?? 0) + 1;
    } else if (status === "timeout") bucket.timeout += 1;
    else if (status === "cancelled") bucket.cancelled += 1;
    const metadata = pair.end.metadata ?? pair.start.metadata;
    if (metadata?.changed === true) bucket.metadata_changed += 1;
  }
  const plugins = [...pluginMap.values()].map((bucket) => ({
    name: bucket.name,
    hooks: Object.fromEntries(
      Object.entries(bucket.hooks).map(([hook, data]) => [
        hook,
        { calls: data.calls, errors: data.errors, latency: durationStats(data.durations) },
      ])
    ),
    latency: durationStats(bucket.durations),
    errors: bucket.errors,
    error_kinds: bucket.error_kinds,
    timeout: bucket.timeout,
    cancelled: bucket.cancelled,
    metadata_changed: bucket.metadata_changed,
  })).sort((a, b) => a.name.localeCompare(b.name));

  // ---------- 错误分类 ----------
  const errorKinds = {};
  for (const event of sorted) {
    if (event.event === "model.failed" || isFailureStatus(event.result?.status)) {
      const kind = event.error?.kind ?? "unclassified";
      errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    }
  }

  // ---------- 窗口 ----------
  let window = { from: null, to: null };
  if (sorted.length > 0) {
    const first = eventTs(sorted[0]);
    const last = eventTs(sorted[sorted.length - 1]);
    window = { from: first !== null ? new Date(first).toISOString() : null, to: last !== null ? new Date(last).toISOString() : null };
  }

  const requestsTotal = requests.length;
  return {
    schema_version: "1.0",
    tool: { name: "dsh-local-telemetry", version: "0.1.1" },
    generated_at: generated,
    window,
    data_completeness: {
      events: sorted.length,
      requests: requestsTotal,
      model_attempts: modelPairs.pairs.length + modelPairs.unmatched.length,
      tool_calls: toolPairs.pairs.length,
      plugin_calls: pluginPairs.pairs.length,
      note: "percentile method: nearest-rank; durations derived from started/completed span pairs; null = unknown, never fabricated",
    },
    requests: {
      total: requestsTotal,
      success: successCount,
      failed: failedCount,
      cancelled: cancelledCount,
      incomplete: requestsTotal - successCount - failedCount - cancelledCount,
      success_rate: requestsTotal > 0 ? round4(successCount / requestsTotal) : null,
      latency: durationStats(requestDurations),
      queue: durationStats(queueValues),
      ttft: durationStats(ttftValues),
      retries: requests.reduce((acc, r) => acc + r.retries, 0),
      fallbacks: requests.reduce((acc, r) => acc + r.fallbacks, 0),
    },
    tokens,
    cost: {
      amount: costSummary.amount,
      currency: catalog?.currency ?? null,
      priced_events: costSummary.priced_events,
      missing: costSummary.missing,
      source: catalog ? catalogPath : null,
      effective_at: catalog?.effective_at ?? null,
      note: "estimate only; not a bill; null when model/usage/price missing",
    },
    models,
    tools,
    tool_loop_hints: loopHints,
    plugins,
    errors: { kinds: errorKinds },
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** --group-by：按组键分区后逐组聚合，输出统一行结构。
 *  model/tool/plugin 维度只统计携带该维度的事件；profile/day 面向全事件。 */
export function aggregateGrouped(events, { groupBy, ...opts } = {}) {
  if (!groupBy) return null;
  const groups = new Map();
  for (const event of events) {
    let key;
    switch (groupBy) {
      case "model": key = event.model?.name ?? null; break;
      case "tool": key = event.event === "tool.started" || event.event === "tool.completed" ? event.tool?.name ?? "unknown" : null; break;
      case "plugin": key = event.event.startsWith("plugin.") ? event.plugin?.name ?? "unknown" : null; break;
      case "profile": key = event.session?.profile ?? "unknown"; break;
      case "day": key = typeof event.timestamp === "string" && event.timestamp.length >= 10 ? event.timestamp.slice(0, 10) : "unknown"; break;
      default: return null;
    }
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const rows = [];
  for (const [key, groupEvents] of groups) {
    const summary = aggregateEvents(groupEvents, opts);
    rows.push({
      group: key,
      events: summary.data_completeness.events,
      requests: summary.requests.total,
      success: summary.requests.success,
      failed: summary.requests.failed,
      cancelled: summary.requests.cancelled,
      p95_ms: summary.requests.latency.p95,
      input_tokens: summary.tokens.input,
      output_tokens: summary.tokens.output,
      cost: summary.cost.amount,
    });
  }
  return rows.sort((a, b) => String(a.group).localeCompare(String(b.group)));
}

/** 慢请求过滤：返回 duration ≥ thresholdMs 的请求 trace_id 集合。 */
export function slowTraceIds(events, thresholdMs) {
  const result = new Set();
  const { pairs } = pairSpans(events, { startedName: "request.started", endNames: ["request.completed", "request.cancelled"] });
  for (const pair of pairs) {
    const duration = spanDuration(pair);
    if (duration !== null && duration >= thresholdMs) {
      result.add(pair.start.trace_id ?? pair.start.span_id);
    }
  }
  for (const event of events) {
    if ((event.event === "request.completed" || event.event === "request.cancelled") && Number.isInteger(event.duration_ms) && event.duration_ms >= thresholdMs) {
      result.add(event.trace_id ?? event.span_id);
    }
  }
  return result;
}

/** Web UI 请求时间线：逐请求行（脱敏白名单字段，无内容）。 */
export function listRequestRows(events, { limit = 100 } = {}) {
  const { rows } = aggregateRequestRows(events);
  return rows.slice(0, limit);
}

function aggregateRequestRows(events) {
  const byTrace = new Map();
  for (const event of events) {
    const trace = event.trace_id ?? event.span_id;
    if (!byTrace.has(trace)) byTrace.set(trace, []);
    byTrace.get(trace).push(event);
  }
  const rows = [];
  for (const [trace, traceEvents] of byTrace) {
    const started = traceEvents.find((e) => e.event === "request.started");
    const terminal = traceEvents.find((e) => e.event === "request.completed" || e.event === "request.cancelled");
    if (!started && !terminal) continue;
    const status = terminal ? (terminal.result?.status ?? (terminal.event === "request.cancelled" ? "cancelled" : "success")) : "incomplete";
    let durationMs = null;
    if (Number.isInteger(terminal?.duration_ms)) durationMs = terminal.duration_ms;
    else {
      const s = started ? Date.parse(started.timestamp ?? "") : null;
      const t = terminal ? Date.parse(terminal.timestamp ?? "") : null;
      if (Number.isFinite(s) && Number.isFinite(t)) durationMs = Math.max(0, t - s);
    }
    const attempts = traceEvents.filter((e) => e.event === "model.requested");
    const lastModel = attempts[attempts.length - 1]?.model?.name ?? null;
    const provider = attempts[attempts.length - 1]?.model?.provider ?? null;
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const event of traceEvents) {
      if (event.event !== "model.completed" || !event.usage) continue;
      if (Number.isInteger(event.usage.input_tokens)) input += event.usage.input_tokens;
      if (Number.isInteger(event.usage.output_tokens)) output += event.usage.output_tokens;
      if (Number.isInteger(event.usage.cached_input_tokens)) cached += event.usage.cached_input_tokens;
    }
    const toolCalls = traceEvents.filter((e) => e.event === "tool.started").length;
    rows.push({
      trace_id: trace,
      profile: started?.session?.profile ?? null,
      status,
      started_at: started?.timestamp ?? terminal?.timestamp ?? null,
      duration_ms: durationMs !== null ? Math.round(durationMs) : null,
      model: lastModel,
      provider,
      model_attempts: attempts.length,
      retries: attempts.length > 1 ? attempts.length - 1 : 0,
      tool_calls: toolCalls,
      tokens: { input, output, cached },
    });
  }
  rows.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
  return { rows };
}

/** --trace：构建 span 树（request 根 → 子 span），孤儿事件挂在 "(unattached)"。 */
export function buildTraceTree(events) {
  const sorted = [...events].sort((a, b) => (eventTs(a) ?? 0) - (eventTs(b) ?? 0));
  const nodes = new Map(); // span_id -> node
  const roots = [];
  for (const event of sorted) {
    const spanId = event.span_id ?? event.event_id;
    if (!nodes.has(spanId)) {
      nodes.set(spanId, { span_id: spanId, children: [], events: [] });
    }
    nodes.get(spanId).events.push({
      event: event.event,
      timestamp: event.timestamp,
      duration_ms: event.duration_ms ?? null,
      status: event.result?.status ?? null,
      model: event.model?.name ?? null,
      tool: event.tool?.name ?? null,
      plugin: event.plugin?.name ?? null,
      hook: event.plugin?.hook ?? null,
      usage: event.usage ?? null,
      error: event.error ?? null,
    });
  }
  for (const [spanId, node] of nodes) {
    const first = sorted.find((e) => (e.span_id ?? e.event_id) === spanId);
    const parentId = first?.parent_id ?? null;
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots };
}

/** --trace：扁平时间线 + 树两种视图共用的事件整理。 */
export function buildTraceView(events) {
  const tree = buildTraceTree(events);
  const timeline = [...events]
    .sort((a, b) => (eventTs(a) ?? 0) - (eventTs(b) ?? 0))
    .map((event) => ({
      event: event.event,
      span_id: event.span_id ?? null,
      parent_id: event.parent_id ?? null,
      timestamp: event.timestamp,
      duration_ms: event.duration_ms ?? null,
      status: event.result?.status ?? null,
      model: event.model?.name ?? null,
      tool: event.tool?.name ?? null,
      plugin: event.plugin?.name ?? null,
      hook: event.plugin?.hook ?? null,
      usage: event.usage ?? null,
      error: event.error?.kind ?? null,
    }));
  const requestEvents = events.filter((e) => e.event === "request.started" || e.event === "request.completed" || e.event === "request.cancelled");
  const rootSpan = requestEvents.find((e) => e.event === "request.started");
  return {
    trace_id: rootSpan?.trace_id ?? events[0]?.trace_id ?? null,
    request_id: rootSpan?.request_id ?? null,
    tree,
    timeline,
  };
}
