import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPriceCatalog, computeCost, sumCosts } from "../src/cost.mjs";

const catalogFixture = {
  currency: "USD",
  effective_at: "2026-08-23T00:00:00Z",
  models: {
    "deepseek-chat": { input_per_million: 0.27, cached_input_per_million: 0.07, output_per_million: 1.1 },
  },
};

test("cost: catalog loads from file with version metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-cost-"));
  const file = join(dir, "prices.json");
  writeFileSync(file, JSON.stringify(catalogFixture), "utf8");
  const { ok, catalog, errors } = loadPriceCatalog(file);
  assert.equal(ok, true, errors.join("; "));
  assert.equal(catalog.currency, "USD");
  assert.equal(catalog.effective_at, "2026-08-23T00:00:00Z");
});

test("cost: catalog with invalid entries rejected explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-cost-"));
  const file = join(dir, "prices.json");
  writeFileSync(file, JSON.stringify({ currency: "USD", models: { "m": { input_per_million: "free" } } }), "utf8");
  const { ok, errors } = loadPriceCatalog(file);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("effective_at")));
  assert.ok(errors.some((e) => e.includes("input_per_million")));
});

test("cost: computed only when model+usage+price all present", () => {
  const result = computeCost({
    model: { provider: "deepseek", name: "deepseek-chat", request_type: "chat" },
    usage: { input_tokens: 4200, output_tokens: 860, cached_input_tokens: 0 },
    catalog: catalogFixture,
  });
  // 4200/1e6*0.27 + 860/1e6*1.1 = 0.001134 + 0.000946 = 0.00208
  assert.ok(Math.abs(result.amount - 0.00208) < 1e-9, String(result.amount));
  assert.equal(result.currency, "USD");
  assert.deepEqual(result.missing, []);
});

test("cost: cached tokens use cached price", () => {
  const result = computeCost({
    model: { name: "deepseek-chat" },
    usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 1_000_000 },
    catalog: catalogFixture,
  });
  assert.ok(Math.abs(result.amount - (0.27 + 0.07)) < 1e-9, String(result.amount));
});

test("cost: missing pieces → null + explicit reason, never fabricated (§5.2)", () => {
  const noModel = computeCost({ model: null, usage: { input_tokens: 1, output_tokens: 1 }, catalog: catalogFixture });
  assert.equal(noModel.amount, null);
  assert.deepEqual(noModel.missing, ["model_missing"]);

  const noUsage = computeCost({ model: { name: "deepseek-chat" }, usage: null, catalog: catalogFixture });
  assert.equal(noUsage.amount, null);
  assert.deepEqual(noUsage.missing, ["usage_missing"]);

  const partialUsage = computeCost({ model: { name: "deepseek-chat" }, usage: { input_tokens: 5, output_tokens: null }, catalog: catalogFixture });
  assert.deepEqual(partialUsage.missing, ["usage_missing"]);

  const noPrice = computeCost({ model: { name: "gpt-unknown" }, usage: { input_tokens: 5, output_tokens: 5 }, catalog: catalogFixture });
  assert.equal(noPrice.amount, null);
  assert.deepEqual(noPrice.missing, ["price_missing"]);

  const noCatalog = computeCost({ model: { name: "deepseek-chat" }, usage: { input_tokens: 5, output_tokens: 5 }, catalog: null });
  assert.equal(noCatalog.amount, null);
  assert.deepEqual(noCatalog.missing, ["catalog_missing"]);
});

test("cost: provider-prefixed model names fall back to tail match", () => {
  const result = computeCost({
    model: { name: "openai/deepseek-chat" },
    usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 },
    catalog: catalogFixture,
  });
  assert.ok(Math.abs(result.amount - 0.27) < 1e-9);
});

test("cost: sumCosts merges amounts and counts missing reasons", () => {
  const ok = computeCost({ model: { name: "deepseek-chat" }, usage: { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 }, catalog: catalogFixture });
  const missing = computeCost({ model: { name: "x" }, usage: { input_tokens: 1, output_tokens: 1 }, catalog: catalogFixture });
  const summary = sumCosts([ok, ok, missing]);
  assert.ok(Math.abs(summary.amount - 0.54) < 1e-9);
  assert.equal(summary.priced_events, 2);
  assert.deepEqual(summary.missing, { price_missing: 1 });
});
