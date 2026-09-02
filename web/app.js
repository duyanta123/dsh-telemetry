/* dsh-telemetry Web UI 逻辑 — 零依赖，只调用本地只读 API。 */
"use strict";

const state = { range: "24h", traceId: null };

const $ = (sel) => document.querySelector(sel);
const fmtInt = (v) => (v === null || v === undefined ? "n/a" : Number(v).toLocaleString("en-US"));
const fmtMs = (v) => (v === null || v === undefined ? "n/a" : v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const fmtPct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const fmtCost = (v, currency) => {
  if (v === null || v === undefined) return "n/a";
  return `${currency === "USD" ? "$" : currency ? currency + " " : ""}${v.toFixed(4)}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function sinceParam() {
  return state.range === "all" ? null : state.range;
}

/* ---------- 状态 chips ---------- */
function renderChips(status, summary) {
  const dropped = status.counters ?? {};
  const droppedTotal = dropped.dropped_write + dropped.dropped_queue + dropped.dropped_oversize + dropped.dropped_invalid + dropped.sampled_out;
  const chips = [
    `store <b>${esc(status.store)}</b>`,
    `events <b>${fmtInt(summary.data_completeness.events)}</b>`,
    droppedTotal > 0 ? `dropped <b>${fmtInt(droppedTotal)}</b>（累计）` : `dropped <b>0</b>`,
    status.price_catalog?.path ? `价格目录 <b>${esc(status.price_catalog.currency ?? "")}</b> 生效 ${esc(status.price_catalog.effective_at ?? "n/a")}` : `价格目录 <b>未配置</b>`,
    `<b>127.0.0.1</b> only`,
  ];
  $("#chips").innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
}

/* ---------- KPI 卡片 ---------- */
function renderKpis(s) {
  const cards = [
    { label: "Requests", value: fmtInt(s.requests.total), note: `成功 ${fmtPct(s.requests.success_rate)} · 取消 ${fmtInt(s.requests.cancelled)}` },
    { label: "P95 latency", value: fmtMs(s.requests.latency.p95), note: `p50 ${fmtMs(s.requests.latency.p50)} · n=${s.requests.latency.n}` },
    { label: "TTFT p95", value: fmtMs(s.requests.ttft.p95), note: `排队 p95 ${fmtMs(s.requests.queue.p95)}` },
    { label: "Tokens in / out", value: fmtInt(s.tokens.input), note: `输出 ${fmtInt(s.tokens.output)} · 缓存 ${fmtInt(s.tokens.cached)}` },
    { label: "Estimated cost", value: fmtCost(s.cost.amount, s.cost.currency), note: `估算值，非账单 · ${s.cost.priced_events} 事件已计价` },
    { label: "Tool / Plugin calls", value: fmtInt(s.data_completeness.tool_calls), note: `插件调用 ${fmtInt(s.data_completeness.plugin_calls)} · 重试 ${fmtInt(s.requests.retries)}` },
  ];
  $("#kpis").innerHTML = cards
    .map(
      (c) => `<div class="kpi"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="note">${c.note}</div></div>`
    )
    .join("");
}

/* ---------- 趋势图（面积 + 柱） ---------- */
function renderTrend(rows) {
  const wrap = $("#trend");
  if (!rows || rows.length === 0) {
    wrap.innerHTML = `<div class="empty">该窗口内暂无数据。</div>`;
    return;
  }
  const data = rows.slice(-31);
  const W = 640, H = 190, padL = 40, padB = 22, padT = 10;
  const innerW = W - padL - 8, innerH = H - padB - padT;
  const maxTok = Math.max(...data.map((d) => d.input_tokens + d.output_tokens), 1);
  const maxReq = Math.max(...data.map((d) => d.requests), 1);
  const step = innerW / data.length;
  const x = (i) => padL + i * step + step / 2;
  const yTok = (v) => padT + innerH - (v / maxTok) * innerH;
  const barW = Math.min(step * 0.34, 16);

  let area = `M ${x(0)} ${yTok(data[0].input_tokens + data[0].output_tokens)}`;
  data.forEach((d, i) => { if (i > 0) area += ` L ${x(i)} ${yTok(d.input_tokens + d.output_tokens)}`; });
  const areaPath = `${area} L ${x(data.length - 1)} ${padT + innerH} L ${x(0)} ${padT + innerH} Z`;

  const bars = data
    .map((d, i) => `<rect class="bar-row" data-i="${i}" x="${x(i) - barW / 2}" y="${padT + innerH - (d.requests / maxReq) * innerH}" width="${barW}" height="${Math.max((d.requests / maxReq) * innerH, d.requests > 0 ? 2 : 0)}" rx="3" fill="rgba(139,92,246,0.35)"></rect>`)
    .join("");
  const labels = data
    .map((d, i) => (data.length <= 10 || i % Math.ceil(data.length / 10) === 0 ? `<text x="${x(i)}" y="${H - 6}" fill="#71717a" font-size="10" text-anchor="middle">${esc(String(d.group).slice(5))}</text>` : ""))
    .join("");
  const gridY = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${padL}" y1="${padT + innerH * f}" x2="${W - 8}" y2="${padT + innerH * f}" stroke="#1c1c22" stroke-width="1"></line><text x="${padL - 6}" y="${padT + innerH * f + 3}" fill="#5b5b64" font-size="9.5" text-anchor="end">${compact(maxTok * (1 - f))}</text>`)
    .join("");

  wrap.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:190px">
    <defs>
      <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(6,182,212,0.45)"></stop>
        <stop offset="100%" stop-color="rgba(6,182,212,0.02)"></stop>
      </linearGradient>
      <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#8b5cf6"></stop><stop offset="100%" stop-color="#06b6d4"></stop>
      </linearGradient>
    </defs>
    ${gridY}
    ${bars}
    <path d="${areaPath}" fill="url(#areaFill)"></path>
    <path d="${area.replace("M", "M")}" fill="none" stroke="url(#lineStroke)" stroke-width="2"></path>
    ${labels}
  </svg>`;

  const tip = $("#trend-tip");
  wrap.querySelectorAll(".bar-row").forEach((el) => {
    el.addEventListener("mousemove", (ev) => {
      const d = data[Number(el.dataset.i)];
      tip.style.display = "block";
      tip.style.left = `${ev.clientX + 12}px`;
      tip.style.top = `${ev.clientY + 12}px`;
      tip.innerHTML = `<div class="t">${esc(d.group)}</div>requests <b>${d.requests}</b> · err <b>${d.failed}</b><br>tokens in <b>${fmtInt(d.input_tokens)}</b> / out <b>${fmtInt(d.output_tokens)}</b><br>cost <b>${fmtCost(d.cost)}</b> · p95 <b>${fmtMs(d.p95_ms)}</b>`;
    });
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });
}

function compact(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

/* ---------- 错误分类 ---------- */
function renderErrors(s) {
  const entries = Object.entries(s.errors.kinds);
  if (entries.length === 0) {
    $("#errors").innerHTML = `<div class="empty">窗口内无错误事件。</div>`;
    return;
  }
  const total = entries.reduce((acc, [, n]) => acc + n, 0);
  $("#errors").innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => {
      const pct = total > 0 ? n / total : 0;
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(kind)}</span><span style="color:var(--muted)">${n} · ${fmtPct(pct)}</span></div>
        <div class="lat-bar" style="margin-top:4px"><i style="width:${Math.round(pct * 100)}%"></i></div>
      </div>`;
    })
    .join("");
}

/* ---------- 表格 ---------- */
function renderModels(models) {
  if (!models || models.length === 0) {
    $("#models").innerHTML = `<div class="empty">窗口内无模型调用。</div>`;
    return;
  }
  const maxP95 = Math.max(...models.map((m) => m.latency.p95 ?? 0), 1);
  $("#models").innerHTML = `<table><thead><tr>
    <th>provider / model</th><th>type</th><th class="num">attempts</th><th class="num">成功率</th>
    <th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th>延迟分布</th>
    <th class="num">TTFT p95</th><th class="num">in tok</th><th class="num">out tok</th><th class="num">缓存</th><th class="num">估算成本</th>
  </tr></thead><tbody>
    ${models
      .map(
        (m) => `<tr>
      <td class="name">${esc(m.provider ?? "?")} / ${esc(m.name ?? "?")}</td>
      <td>${esc(m.request_type ?? "?")}</td>
      <td class="num">${m.attempts}${m.retries > 0 ? ` <span style="color:var(--warn)" title="重试">↻${m.retries}</span>` : ""}</td>
      <td class="num">${fmtPct(m.success_rate)}</td>
      <td class="num">${fmtMs(m.latency.p50)}</td>
      <td class="num">${fmtMs(m.latency.p95)}</td>
      <td class="num">${fmtMs(m.latency.p99)}</td>
      <td><div class="lat-bar"><i style="width:${Math.round(((m.latency.p95 ?? 0) / maxP95) * 100)}%"></i></div></td>
      <td class="num">${fmtMs(m.ttft.p95)}</td>
      <td class="num">${fmtInt(m.tokens.input)}</td>
      <td class="num">${fmtInt(m.tokens.output)}</td>
      <td class="num">${fmtInt(m.tokens.cached)}</td>
      <td class="num">${fmtCost(m.cost.amount, null)}</td>
    </tr>`
      )
      .join("")}
  </tbody></table>`;
}

function renderTools(tools, hints) {
  if (!tools || tools.length === 0) {
    $("#tools").innerHTML = `<div class="empty">窗口内无工具调用。</div>`;
    return;
  }
  const hintByTool = {};
  (hints ?? []).forEach((h) => { hintByTool[h.tool] = h; });
  const maxP95 = Math.max(...tools.map((t) => t.latency.p95 ?? 0), 1);
  $("#tools").innerHTML = `<table><thead><tr>
      <th>工具</th><th class="num">调用</th><th class="num">成功</th><th class="num">失败</th><th class="num">超时</th>
      <th class="num">p50</th><th class="num">p95</th><th>耗时分布</th><th class="num">需确认</th>
    </tr></thead><tbody>
    ${tools
      .map((t) => {
        const hint = hintByTool[t.name];
        const loop = hint ? ` <span style="color:var(--warn)" title="同 trace 内 ${hint.calls} 次调用（疑似循环）">⟲</span>` : "";
        return `<tr>
        <td class="name">${esc(t.name)}${loop}</td>
        <td class="num">${t.calls}</td><td class="num">${t.success}</td><td class="num">${t.failed}</td><td class="num">${t.timeout}</td>
        <td class="num">${fmtMs(t.latency.p50)}</td><td class="num">${fmtMs(t.latency.p95)}</td>
        <td><div class="lat-bar"><i style="width:${Math.round(((t.latency.p95 ?? 0) / maxP95) * 100)}%"></i></div></td>
        <td class="num">${t.confirm_required || ""}</td>
      </tr>`;
      })
      .join("")}
  </tbody></table>`;
}

function renderPlugins(plugins) {
  if (!plugins || plugins.length === 0) {
    $("#plugins").innerHTML = `<div class="empty">窗口内无插件调用。</div>`;
    return;
  }
  $("#plugins").innerHTML = `<table><thead><tr><th>插件</th><th>hook</th><th class="num">调用</th><th class="num">错误</th><th class="num">p95</th></tr></thead><tbody>
    ${plugins
      .map((p) => {
        const hooks = Object.entries(p.hooks);
        if (hooks.length === 0) {
          return `<tr><td class="name">${esc(p.name)}</td><td>-</td><td class="num">-</td><td class="num">${p.errors}</td><td class="num">${fmtMs(p.latency.p95)}</td></tr>`;
        }
        return hooks
          .map(
            ([hook, data], i) =>
              `<tr>${i === 0 ? `<td class="name" rowspan="${hooks.length}">${esc(p.name)}</td>` : ""}<td>${esc(hook)}</td><td class="num">${data.calls}</td><td class="num">${data.errors}</td><td class="num">${fmtMs(data.latency.p95)}</td></tr>`
          )
          .join("");
      })
      .join("")}
  </tbody></table>`;
}

/* ---------- 请求时间线 + trace ---------- */
function renderRequests(requests) {
  const el = $("#requests");
  if (!requests || requests.length === 0) {
    el.innerHTML = `<div class="empty">窗口内无请求。</div>`;
    return;
  }
  el.innerHTML = requests
    .map(
      (r) => `<div class="req${r.trace_id === state.traceId ? " active" : ""}" data-trace="${esc(r.trace_id)}">
      <span class="dot ${esc(r.status)}" title="${esc(r.status)}"></span>
      <span class="t">${esc((r.started_at ?? "").replace("T", " ").slice(0, 19))}</span>
      <span class="dur">${fmtMs(r.duration_ms)}</span>
      <span class="model">${esc(r.model ?? "—")}${r.retries > 0 ? ` <span style="color:var(--warn)">↻${r.retries}</span>` : ""}${r.tool_calls > 0 ? ` <span style="color:var(--muted)">· ${r.tool_calls} tools</span>` : ""}</span>
      <span class="tok">${fmtInt(r.tokens.input)}/${fmtInt(r.tokens.output)}</span>
    </div>`
    )
    .join("");
  el.querySelectorAll(".req").forEach((node) => {
    node.addEventListener("click", () => {
      state.traceId = node.dataset.trace;
      el.querySelectorAll(".req").forEach((n) => n.classList.remove("active"));
      node.classList.add("active");
      loadTrace(state.traceId);
    });
  });
}

function renderTrace(view) {
  $("#trace-title").textContent = view.trace_id ? `· ${view.trace_id}` : "";
  const el = $("#trace");
  const renderNode = (node, depth) => {
    const head = node.events[0] ?? {};
    const who = head.tool ?? head.plugin ?? head.model ?? "";
    const end = [...node.events].reverse().find((e) => Number.isInteger(e.duration_ms));
    const status = node.events.map((e) => e.status).find(Boolean);
    const ms = end ? end.duration_ms : null;
    const hook = head.hook ? `:${head.hook}` : "";
    let html = `<div class="span-row" style="margin-left:${depth * 0}px">
      <span class="ev">${esc(head.event ?? "")}</span>
      ${who ? `<span class="who">${esc(who)}${esc(hook)}</span>` : ""}
      ${status ? `<span class="st ${esc(status)}">${esc(status)}</span>` : ""}
      ${ms !== null && ms !== undefined ? `<span class="ms">${fmtMs(ms)}</span>` : ""}
    </div>`;
    if (node.children && node.children.length > 0) {
      html += `<div class="span-children">${node.children.map((c) => renderNode(c, depth + 1)).join("")}</div>`;
    }
    return html;
  };
  const treeHtml = view.tree.roots.map((r) => renderNode(r, 0)).join("");
  const timelineHtml = view.timeline
    .slice(0, 60)
    .map(
      (e) => `<div class="span-row"><span class="ev">${esc(e.event)}</span>
      ${e.tool ?? e.plugin ?? e.model ? `<span class="who">${esc(e.tool ?? e.plugin ?? e.model ?? "")}</span>` : ""}
      ${e.status ? `<span class="st ${esc(e.status)}">${esc(e.status)}</span>` : ""}
      ${e.error ? `<span class="st failed">${esc(e.error)}</span>` : ""}
      ${e.duration_ms !== null ? `<span class="ms">${fmtMs(e.duration_ms)}</span>` : ""}</div>`
    )
    .join("");
  el.innerHTML = `${treeHtml}<div class="desc" style="margin:12px 0 4px">时间线（最近 ${Math.min(view.timeline.length, 60)} / ${view.timeline.length} 事件）</div>${timelineHtml}`;
}

async function loadTrace(traceId) {
  try {
    const view = await api(`/api/trace/${encodeURIComponent(traceId)}`);
    renderTrace(view);
  } catch {
    $("#trace").innerHTML = `<div class="empty">trace 事件未找到（可能被采样或清理）。</div>`;
  }
}

/* ---------- 主刷新 ---------- */
async function refresh() {
  const since = sinceParam();
  const qs = since ? `since=${encodeURIComponent(since)}` : "";
  const [status, summary, grouped, requests] = await Promise.all([
    api("/api/status"),
    api(`/api/summary?${qs}`),
    api(`/api/grouped?by=day&${qs}`),
    api(`/api/requests?limit=60&${qs}`),
  ]);
  renderChips(status, summary);
  renderKpis(summary);
  renderTrend(grouped.rows);
  renderErrors(summary);
  renderModels(summary.models);
  renderTools(summary.tools, summary.tool_loop_hints);
  renderPlugins(summary.plugins);
  renderRequests(requests.requests);
  if (state.traceId) await loadTrace(state.traceId);
}

document.querySelectorAll("#ranges button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.range = btn.dataset.range;
    refresh().catch(showError);
  });
});
$("#refresh").addEventListener("click", () => refresh().catch(showError));

function showError(error) {
  $("#chips").innerHTML = `<span class="chip bad">加载失败：${esc(error.message)}（请确认服务运行在本地存储上）</span>`;
}

refresh().catch(showError);
