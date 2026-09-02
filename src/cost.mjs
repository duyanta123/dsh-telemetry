/**
 * dsh-local-telemetry — 成本模型（计划 §5）。
 *
 * 价格不入代码：来自版本化目录文件（currency / effective_at / models）。
 * 只有 模型名、Token 用量、价格 三者齐备才计算；否则 cost=null 并给出原因，
 * 绝不编造（§5.2）。
 */

import { readFileSync } from "node:fs";

/**
 * 加载价格目录。
 * @returns {{ ok: boolean, errors: string[], catalog: object|null }}
 */
export function loadPriceCatalog(path) {
  if (!path || typeof path !== "string") {
    return { ok: false, errors: ["price_catalog not configured"], catalog: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`price catalog unreadable (${error.code ?? error.message})`], catalog: null };
  }
  const errors = [];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ["price catalog must be a JSON object"], catalog: null };
  }
  if (typeof parsed.currency !== "string" || parsed.currency.length !== 3) errors.push("currency must be a 3-letter code");
  if (typeof parsed.effective_at !== "string" || parsed.effective_at.length === 0) errors.push("effective_at is required");
  if (typeof parsed.models !== "object" || parsed.models === null) errors.push("models is required");
  else {
    for (const [name, price] of Object.entries(parsed.models)) {
      if (typeof price !== "object" || price === null) {
        errors.push(`models.${name} must be an object`);
        continue;
      }
      for (const field of ["input_per_million", "output_per_million"]) {
        const value = price[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`models.${name}.${field} must be a non-negative number`);
      }
      if (price.cached_input_per_million !== undefined && price.cached_input_per_million !== null) {
        const value = price.cached_input_per_million;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`models.${name}.cached_input_per_million must be a non-negative number`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, catalog: null };
  return { ok: true, errors, catalog: parsed };
}

function priceFor(catalog, modelName) {
  if (!catalog || typeof modelName !== "string" || modelName.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(catalog.models, modelName)) return catalog.models[modelName];
  // 带前缀的模型名（如 provider/name）回退到末段匹配
  const tail = modelName.split("/").pop();
  if (tail !== modelName && Object.prototype.hasOwnProperty.call(catalog.models, tail)) return catalog.models[tail];
  return null;
}

/**
 * 计算单事件成本。
 * @returns {{ amount: number|null, currency: string|null, effective_at: string|null, missing: string[] }}
 *   amount 为 null 时 missing 给出原因（model_missing / usage_missing / price_missing / catalog_missing）。
 */
export function computeCost({ model, usage, catalog }) {
  if (!catalog) {
    return { amount: null, currency: null, effective_at: null, missing: ["catalog_missing"] };
  }
  const modelName = typeof model === "object" && model !== null ? model.name : null;
  if (!modelName || typeof modelName !== "string") {
    return { amount: null, currency: catalog.currency, effective_at: catalog.effective_at, missing: ["model_missing"] };
  }
  if (typeof usage !== "object" || usage === null) {
    return { amount: null, currency: catalog.currency, effective_at: catalog.effective_at, missing: ["usage_missing"] };
  }
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (!Number.isInteger(input) || !Number.isInteger(output)) {
    return { amount: null, currency: catalog.currency, effective_at: catalog.effective_at, missing: ["usage_missing"] };
  }
  const price = priceFor(catalog, modelName);
  if (!price) {
    return { amount: null, currency: catalog.currency, effective_at: catalog.effective_at, missing: ["price_missing"] };
  }
  const cached = Number.isInteger(usage.cached_input_tokens) ? usage.cached_input_tokens : 0;
  const cachedPrice = typeof price.cached_input_per_million === "number" ? price.cached_input_per_million : price.input_per_million;
  const amount =
    (input / 1_000_000) * price.input_per_million +
    (cached / 1_000_000) * cachedPrice +
    (output / 1_000_000) * price.output_per_million;
  return {
    amount: Math.round(amount * 1e9) / 1e9, // 去浮点噪声，保留纳级精度
    currency: catalog.currency,
    effective_at: catalog.effective_at,
    missing: [],
  };
}

/** 聚合级成本汇总：逐事件计算并合并，缺失原因计数；无已计价事件时 amount 为 null。 */
export function sumCosts(costResults) {
  let amount = 0;
  let pricedEvents = 0;
  const missing = {};
  for (const result of costResults) {
    if (result.amount === null) {
      for (const reason of result.missing) missing[reason] = (missing[reason] ?? 0) + 1;
    } else {
      amount += result.amount;
      pricedEvents += 1;
    }
  }
  return {
    amount: pricedEvents > 0 ? Math.round(amount * 1e9) / 1e9 : null,
    priced_events: pricedEvents,
    missing,
  };
}
