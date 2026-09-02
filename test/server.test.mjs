import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTelemetryServer } from "../src/server.mjs";
import { createJsonlStore } from "../src/store.mjs";
import { loadPriceCatalog } from "../src/cost.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureData = join(root, "test", "fixtures", "telemetry-data");

async function withServer(path, fn) {
  const store = createJsonlStore({ path });
  const catalog = loadPriceCatalog(join(root, "test", "fixtures", "prices.json")).catalog;
  const server = createTelemetryServer({ store, catalog, catalogPath: "test/fixtures/prices.json" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, server);
  } finally {
    server.close();
    if (typeof store.close === "function") store.close();
  }
}

test("server: serves local static UI assets", async () => {
  await withServer(fixtureData, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("DSH Telemetry"));
    const css = await (await fetch(`${base}/style.css`)).text();
    assert.ok(css.includes("--accent-a"));
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.ok(js.includes("/api/summary"));
  });
});

test("server: /api/summary returns recomputable aggregate with dropped counters", async () => {
  await withServer(fixtureData, async (base) => {
    const res = await fetch(`${base}/api/summary`);
    assert.equal(res.status, 200);
    const summary = await res.json();
    assert.equal(summary.requests.total, 3);
    assert.equal(summary.tokens.input, 5400);
    assert.equal(summary.dropped.written, 0);
    assert.equal(summary.cost.currency, "USD");
  });
});

test("server: /api/summary honors since/errors_only/slow_over_ms", async () => {
  await withServer(fixtureData, async (base) => {
    const errors = await (await fetch(`${base}/api/summary?errors_only=1`)).json();
    assert.equal(errors.data_completeness.events, 2);

    const slow = await (await fetch(`${base}/api/summary?slow_over_ms=8500`)).json();
    assert.equal(slow.requests.total, 1); // 8100 < 8500（否），9100 >= 8500（是），1000（否）

    const since = await (await fetch(`${base}/api/summary?since=2026-08-23T12%3A06%3A00.000Z`)).json();
    assert.equal(since.requests.total, 1);
  });
});

test("server: /api/requests returns whitelisted request rows", async () => {
  await withServer(fixtureData, async (base) => {
    const { requests } = await (await fetch(`${base}/api/requests?limit=10`)).json();
    assert.equal(requests.length, 3);
    const row = requests.find((r) => r.trace_id === "trace-002");
    assert.equal(row.duration_ms, 9100);
    assert.equal(JSON.stringify(row).includes("prompt"), false);
  });
});

test("server: /api/grouped supports day/model", async () => {
  await withServer(fixtureData, async (base) => {
    const byDay = await (await fetch(`${base}/api/grouped?by=day`)).json();
    assert.equal(byDay.rows[0].group, "2026-08-23");
    const byModel = await (await fetch(`${base}/api/grouped?by=model`)).json();
    assert.ok(byModel.rows.some((r) => r.group === "deepseek-chat"));
  });
});

test("server: /api/trace/<id> returns tree; unknown id 404", async () => {
  await withServer(fixtureData, async (base) => {
    const view = await (await fetch(`${base}/api/trace/trace-001`)).json();
    assert.equal(view.tree.roots.length, 1);
    assert.equal(view.timeline.length, 12);
    const missing = await fetch(`${base}/api/trace/nope`);
    assert.equal(missing.status, 404);
  });
});

test("server: /api/status marks localhost_only and price catalog", async () => {
  await withServer(fixtureData, async (base) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.localhost_only, true);
    assert.equal(status.price_catalog.currency, "USD");
    assert.equal(status.counters.written, 0);
  });
});

test("server: /api/report.md renders the markdown report", async () => {
  await withServer(fixtureData, async (base) => {
    const md = await (await fetch(`${base}/api/report.md?since=24h`)).text();
    assert.ok(md.includes("# Harness 遥测报告"));
    assert.ok(md.includes("## 5. 模型比较"));
  });
});

test("server: read-only — non-GET rejected, unknown paths 404", async () => {
  await withServer(fixtureData, async (base) => {
    const post = await fetch(`${base}/api/summary`, { method: "POST" });
    assert.equal(post.status, 405);
    const body = await post.json();
    assert.equal(body.error, "read-only interface");
    const missing = await fetch(`${base}/api/nothing`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.equal(traversal.status, 404);
  });
});
