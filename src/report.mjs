/**
 * dsh-local-telemetry — 报告渲染（计划 §9）。
 *
 * 文本摘要（§9.1）与 Markdown 报告（§9.2）。所有百分比、分位数和成本
 * 都注明时间范围、样本数和数据完整性；成本恒标注「估算，非账单」。
 */

function fmtMs(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 10000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function fmtNum(value) {
  if (value === null || value === undefined) return "n/a";
  return Number(value).toLocaleString("en-US");
}

function fmtCost(value, currency) {
  if (value === null || value === undefined) return "n/a";
  const symbol = currency === "USD" ? "$" : currency ? `${currency} ` : "";
  return `${symbol}${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function fmtPct(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

/** CLI 文本摘要（对齐计划 §9.1 示例）。 */
export function renderTextSummary(summary, { dropped = null, store = "jsonl" } = {}) {
  const lines = [];
  const w = summary.window;
  lines.push(`Telemetry summary (${store})`);
  lines.push(`Window          ${w.from ?? "n/a"} .. ${w.to ?? "n/a"}`);
  lines.push(`Events          ${fmtNum(summary.data_completeness.events)}`);
  lines.push(`Requests        ${fmtNum(summary.requests.total)}`);
  lines.push(`Success         ${fmtNum(summary.requests.success)} (${fmtPct(summary.requests.success_rate)})`);
  lines.push(`Errors          ${fmtNum(summary.requests.failed)}`);
  lines.push(`Cancelled       ${fmtNum(summary.requests.cancelled)}`);
  lines.push(`P95 latency     ${fmtMs(summary.requests.latency.p95)} (n=${summary.requests.latency.n}, nearest-rank)`);
  lines.push(`P50 latency     ${fmtMs(summary.requests.latency.p50)}`);
  lines.push(`Queue p95       ${fmtMs(summary.requests.queue.p95)} (n=${summary.requests.queue.n})`);
  lines.push(`TTFT p95        ${fmtMs(summary.requests.ttft.p95)} (n=${summary.requests.ttft.n})`);
  lines.push(`Retries         ${fmtNum(summary.requests.retries)}  Fallbacks ${fmtNum(summary.requests.fallbacks)}`);
  lines.push(`Input tokens    ${fmtNum(summary.tokens.input)}`);
  lines.push(`Output tokens   ${fmtNum(summary.tokens.output)}`);
  lines.push(`Cached tokens   ${fmtNum(summary.tokens.cached)}`);
  lines.push(`Estimated cost  ${fmtCost(summary.cost.amount, summary.cost.currency)} (estimate, not a bill)`);
  lines.push(`Tool calls      ${fmtNum(summary.data_completeness.tool_calls)}`);
  lines.push(`Plugin calls    ${fmtNum(summary.data_completeness.plugin_calls)}`);
  if (dropped) {
    const totalDropped = dropped.dropped_write + dropped.dropped_queue + dropped.dropped_oversize + dropped.dropped_invalid + dropped.sampled_out;
    lines.push(`Dropped events  ${fmtNum(totalDropped)} (write=${dropped.dropped_write} queue=${dropped.dropped_queue} oversize=${dropped.dropped_oversize} invalid=${dropped.dropped_invalid} sampled=${dropped.sampled_out}, cumulative)`);
  }
  return lines.join("\n");
}

/** --group-by 文本表。 */
export function renderGroupedText(rows, groupBy) {
  const lines = [`Grouped by ${groupBy}:`];
  lines.push(`${"group".padEnd(28)} ${"events".padStart(7)} ${"req".padStart(6)} ${"ok".padStart(6)} ${"err".padStart(5)} ${"p95".padStart(10)} ${"in_tok".padStart(10)} ${"out_tok".padStart(10)} ${"cost".padStart(12)}`);
  for (const row of rows) {
    lines.push(
      [
        String(row.group).slice(0, 27).padEnd(28),
        String(row.events).padStart(7),
        String(row.requests).padStart(6),
        String(row.success).padStart(6),
        String(row.failed).padStart(5),
        fmtMs(row.p95_ms).padStart(10),
        fmtNum(row.input_tokens).padStart(10),
        fmtNum(row.output_tokens).padStart(10),
        fmtCost(row.cost).padStart(12),
      ].join(" ")
    );
  }
  return lines.join("\n");
}

/** --trace 文本视图（树 + 时间线）。 */
export function renderTraceText(view) {
  const lines = [];
  lines.push(`Trace ${view.trace_id ?? "(unknown)"}${view.request_id ? `  request_id=${view.request_id}` : ""}`);
  lines.push("");
  const renderNode = (node, depth) => {
    const head = node.events[0] ?? {};
    const label = head.tool ?? head.plugin ?? head.model ?? "";
    const duration = node.events.find((e) => Number.isInteger(e.duration_ms))?.duration_ms ?? null;
    lines.push(`${"  ".repeat(depth)}- ${node.span_id}  ${label ? `[${label}] ` : ""}${duration !== null ? fmtMs(duration) : ""}`);
    for (const child of node.children) renderNode(child, depth + 1);
  };
  for (const root of view.tree.roots) renderNode(root, 0);
  lines.push("");
  lines.push("Timeline:");
  for (const item of view.timeline) {
    const label = item.tool ?? item.plugin ?? item.model ?? "";
    const status = item.status ? ` status=${item.status}` : "";
    const duration = item.duration_ms !== null ? ` dur=${item.duration_ms}ms` : "";
    lines.push(`  ${item.timestamp}  ${item.event.padEnd(18)} ${label}${status}${duration}`);
  }
  return lines.join("\n");
}

/**
 * Markdown 报告（计划 §9.2 固定章节结构）。
 * @param {object} summary aggregateEvents 结果
 * @param {object} meta { store, path, dropped, command, priceCatalogPath }
 */
export function renderMarkdownReport(summary, meta = {}) {
  const s = summary;
  const out = [];
  out.push("# Harness 遥测报告");
  out.push("");
  out.push(`> 由 \`dsh-local-telemetry\` 生成于 ${s.generated_at}；成本为估算值，非实际账单。`);
  out.push("");

  out.push("## 1. 时间范围与数据完整性");
  out.push("");
  out.push(`- 存储后端：${meta.store ?? "jsonl"}（${meta.path ?? "n/a"}）`);
  out.push(`- 事件时间范围：${s.window.from ?? "n/a"} → ${s.window.to ?? "n/a"}`);
  out.push(`- 事件数：${s.data_completeness.events}（请求 ${s.data_completeness.requests}，模型 attempt ${s.data_completeness.model_attempts}，工具调用 ${s.data_completeness.tool_calls}，插件调用 ${s.data_completeness.plugin_calls}）`);
  if (meta.dropped) {
    const totalDropped = meta.dropped.dropped_write + meta.dropped.dropped_queue + meta.dropped.dropped_oversize + meta.dropped.dropped_invalid + meta.dropped.sampled_out;
    out.push(`- 丢弃事件（累计）：${totalDropped}（write=${meta.dropped.dropped_write}，queue=${meta.dropped.dropped_queue}，oversize=${meta.dropped.dropped_oversize}，invalid=${meta.dropped.dropped_invalid}，sampled=${meta.dropped.sampled_out}）`);
  }
  out.push(`- 分位数方法：nearest-rank；时长来自 started/completed span 配对；null 表示未知，不补 0。`);
  out.push("");

  out.push("## 2. 请求和错误概览");
  out.push("");
  out.push(`- 请求总数 ${s.requests.total}；成功 ${s.requests.success}（${fmtPct(s.requests.success_rate)}）；失败 ${s.requests.failed}；取消 ${s.requests.cancelled}；未闭合 ${s.requests.incomplete}`);
  const kinds = Object.entries(s.errors.kinds);
  out.push(`- 错误分类：${kinds.length === 0 ? "无" : kinds.map(([k, n]) => `${k}=${n}`).join("、")}`);
  out.push(`- 重试 ${s.requests.retries} 次；模型回退 ${s.requests.fallbacks} 次`);
  out.push("");

  out.push("## 3. 延迟分布");
  out.push("");
  out.push(`| 指标 | p50 | p95 | p99 | avg | n |`);
  out.push(`| --- | --- | --- | --- | --- | --- |`);
  out.push(`| 请求总耗时 | ${fmtMs(s.requests.latency.p50)} | ${fmtMs(s.requests.latency.p95)} | ${fmtMs(s.requests.latency.p99)} | ${fmtMs(s.requests.latency.avg)} | ${s.requests.latency.n} |`);
  out.push(`| 排队耗时 | ${fmtMs(s.requests.queue.p50)} | ${fmtMs(s.requests.queue.p95)} | ${fmtMs(s.requests.queue.p99)} | ${fmtMs(s.requests.queue.avg)} | ${s.requests.queue.n} |`);
  out.push(`| 首 Token 延迟 | ${fmtMs(s.requests.ttft.p50)} | ${fmtMs(s.requests.ttft.p95)} | ${fmtMs(s.requests.ttft.p99)} | ${fmtMs(s.requests.ttft.avg)} | ${s.requests.ttft.n} |`);
  out.push("");

  out.push("## 4. Token 与成本");
  out.push("");
  out.push(`- 输入 Token：${fmtNum(s.tokens.input)}；输出 Token：${fmtNum(s.tokens.output)}；缓存命中 Token：${fmtNum(s.tokens.cached)}（含 usage 的事件 ${s.tokens.events_with_usage}）`);
  out.push(`- 估算成本：${fmtCost(s.cost.amount, s.cost.currency)}（来源：${s.cost.source ?? "未配置价格目录"}，生效时间 ${s.cost.effective_at ?? "n/a"}）`);
  const missing = Object.entries(s.cost.missing);
  out.push(`- 未计价原因：${missing.length === 0 ? "无" : missing.map(([k, n]) => `${k}=${n}`).join("、")}`);
  out.push("");

  out.push("## 5. 模型比较");
  out.push("");
  if (s.models.length === 0) {
    out.push("_窗口内无模型调用。_");
  } else {
    out.push(`| provider | model | type | attempts | 成功率 | p95 延迟 | TTFT p95 | in/out/cached tok | 估算成本 |`);
    out.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const m of s.models) {
      out.push(`| ${m.provider ?? "?"} | ${m.name ?? "?"} | ${m.request_type ?? "?"} | ${m.attempts} | ${fmtPct(m.success_rate)} | ${fmtMs(m.latency.p95)} | ${fmtMs(m.ttft.p95)} | ${fmtNum(m.tokens.input)}/${fmtNum(m.tokens.output)}/${fmtNum(m.tokens.cached)} | ${fmtCost(m.cost.amount, s.cost.currency)} |`);
    }
  }
  out.push("");

  out.push("## 6. 工具与插件耗时");
  out.push("");
  if (s.tools.length === 0) out.push("_窗口内无工具调用。_");
  else {
    out.push(`| 工具 | 调用 | 成功 | 失败 | 超时 | p50 | p95 | 需确认 |`);
    out.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const t of s.tools) {
      out.push(`| ${t.name} | ${t.calls} | ${t.success} | ${t.failed} | ${t.timeout} | ${fmtMs(t.latency.p50)} | ${fmtMs(t.latency.p95)} | ${t.confirm_required} |`);
    }
  }
  out.push("");
  if (s.plugins.length === 0) out.push("_窗口内无插件调用。_");
  else {
    out.push(`| 插件 | hook | 调用 | 错误 | p95 |`);
    out.push(`| --- | --- | --- | --- | --- |`);
    for (const p of s.plugins) {
      const hookEntries = Object.entries(p.hooks);
      if (hookEntries.length === 0) out.push(`| ${p.name} | - | - | ${p.errors} | ${fmtMs(p.latency.p95)} |`);
      else for (const [hook, data] of hookEntries) out.push(`| ${p.name} | ${hook} | ${data.calls} | ${data.errors} | ${fmtMs(data.latency.p95)} |`);
    }
  }
  out.push("");

  out.push("## 7. 慢请求和失败请求");
  out.push("");
  out.push(`> 以 \`--slow-over-ms\` / \`--errors-only\` 过滤后重新运行可获取完整明细；本节列出当前窗口内的失败请求 trace。`);
  out.push("");
  const failedTraces = s.requests.failed > 0 || s.requests.cancelled > 0 ? "见 `--summary --errors-only --group-by day` 输出与 `--trace` 明细。" : "无失败请求。";
  out.push(failedTraces);
  out.push("");

  out.push("## 8. 缓存、重试和回退");
  out.push("");
  out.push(`- 缓存命中 Token：${fmtNum(s.tokens.cached)}（占输入 ${s.tokens.input > 0 ? fmtPct(s.tokens.cached / s.tokens.input) : "n/a"}）`);
  out.push(`- 重试：${s.requests.retries}；模型回退：${s.requests.fallbacks}`);
  out.push("");

  out.push("## 9. 数据隐私与丢弃事件");
  out.push("");
  out.push("- 本插件默认不采集 prompt、response、文件内容、命令参数与环境变量；成本与 Token 均为宿主/模型返回的真实 usage。");
  out.push("- 事件中的名称（模型/工具/插件/profile）可配置哈希化；metadata 仅在显式开启 safe 模式并脱敏后附加。");
  out.push(`- 丢弃事件累计：${meta.dropped ? meta.dropped.dropped_write + meta.dropped.dropped_queue + meta.dropped.dropped_oversize + meta.dropped.dropped_invalid + meta.dropped.sampled_out : "n/a"}（见第 1 节明细）。`);
  out.push("");

  out.push("## 附录");
  out.push("");
  out.push(`- 生成命令：\`${meta.command ?? "node bin/telemetry.mjs --summary --format markdown"}\``);
  out.push("- 事件 schema：`docs/schema.md`（schema_version 1.0）");
  out.push(`- 价格目录：${meta.priceCatalogPath ?? "未配置"}（版本化，见计划 §5）`);
  out.push(`- 工具版本：${s.tool.version}；schema_version：${s.schema_version}`);
  out.push("");
  return out.join("\n");
}
