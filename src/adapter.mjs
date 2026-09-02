/**
 * dsh-local-telemetry — 宿主适配器（计划 §2）。
 *
 * DSH Harness 的生命周期 Hook（request.started / model.completed / …）目前
 * 无法确认其真实暴露面。按计划 §2 的降级路径：
 *   1. 只实现独立事件记录器与显式适配器接口；
 *   2. 只接入已确认存在的生命周期事件（当前：无，全部经显式 emit 接入）；
 *   3. 缺失指标返回 null / unavailable，不从时间戳臆造；
 *   4. 用适配器隔离具体 DSH 版本，宿主私有 API 不散落到各模块。
 *
 * 因此 getCapabilities() 如实声明：lifecycle_hooks: "unconfirmed"。
 * 宿主未来确认 Hook 后，仅需提供一个新的 adapter 实现，其余模块零改动。
 */

import { SCHEMA_VERSION } from "./schema.mjs";

/** 能力声明：未确认的能力一律 "unconfirmed"，不得伪造成可用。 */
export function createCapabilities(overrides = {}) {
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    lifecycle_hooks: "unconfirmed", // "full" | "partial" | "none" | "unconfirmed"
    events: [], // 宿主确认可提供的事件名；显式接入模式下由 emit 方声明
    usage_tokens: "unconfirmed",
    cache_tokens: "unconfirmed",
    cost_model: "catalog", // 成本来自版本化价格目录，非宿主
    ...overrides,
  });
}

/**
 * 显式事件总线适配器 — 当前唯一受支持的接入方式。
 * 嵌入方（宿主集成代码、其他插件、测试）通过 emit() 送入事件，
 * 录制器经 on() 消费。on() 返回解绑函数。
 */
export function createEventBusAdapter({ capabilities } = {}) {
  const handlers = new Map(); // eventName | "*" -> Set<handler>
  const caps = createCapabilities({
    lifecycle_hooks: "none",
    ...capabilities,
  });

  function on(eventName, handler) {
    if (typeof handler !== "function") return () => {};
    if (!handlers.has(eventName)) handlers.set(eventName, new Set());
    handlers.get(eventName).add(handler);
    return () => handlers.get(eventName)?.delete(handler);
  }

  function emit(event) {
    let delivered = 0;
    const sets = [handlers.get("*"), handlers.get(event?.event)].filter(Boolean);
    for (const set of sets) {
      for (const handler of set) {
        try {
          handler(event);
          delivered += 1;
        } catch {
          /* 单个 handler 异常不阻断其余订阅者（fail-open） */
        }
      }
    }
    return delivered;
  }

  function getCapabilities() {
    return caps;
  }

  return { on, emit, getCapabilities };
}

/**
 * 能力探测：以最保守结果响应。绝不因为探测代码「没有抛错」就声明宿主
 * 具备 Hook（缺失宿主能力不会被伪造成可用指标 —— Phase 0 验收）。
 */
export function detectCapabilities(host) {
  if (!host || typeof host !== "object") return createCapabilities();
  return createCapabilities();
}
