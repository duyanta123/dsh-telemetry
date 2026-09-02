/**
 * dsh-local-telemetry — 采样（计划 §7.3）。
 *
 * 决策以 trace 为粒度（同一 trace_id 的所有事件同决策，trace 不断裂），
 * 通过 salted hash 把 trace_id 确定性映射到 [0,1) 与 sample_rate 比较。
 * 错误、取消与慢请求默认绕过采样；丢弃时把原因计入 sink 计数器。
 */

import { createHash } from "node:crypto";

export const SAMPLING_STRATEGY = "per-trace-hash-v1";

/** trace_id → [0,1) 的确定性映射。 */
export function traceUnit(traceId, salt) {
  const digest = createHash("sha256").update(`${salt}\u0000${traceId ?? ""}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * @param {object} opts
 * @param {number} opts.sampleRate 0..1
 * @param {boolean} opts.errorsAlwaysSample
 * @param {number} [opts.slowRequestMs] 慢请求阈值；请求级 duration 超过则保留
 * @param {string} opts.salt 哈希 salt（与名称哈希共用同一数据目录 salt）
 */
export function createSampler({ sampleRate, errorsAlwaysSample = true, slowRequestMs = null, salt }) {
  const rate = Math.min(Math.max(sampleRate ?? 1, 0), 1);

  /**
   * @returns {{ kept: boolean, reason: "always-error"|"slow"|"rate"|"sampled-out" }}
   */
  function decide(event, { durationMs = null } = {}) {
    const status = event.result?.status;
    const isError =
      event.event === "model.failed" || event.event === "request.cancelled" || status === "failed" || status === "timeout" || status === "cancelled";
    if (errorsAlwaysSample && isError) return { kept: true, reason: "always-error" };
    if (slowRequestMs !== null && Number.isFinite(durationMs) && durationMs >= slowRequestMs) {
      return { kept: true, reason: "slow" };
    }
    if (traceUnit(event.trace_id, salt) < rate) return { kept: true, reason: "rate" };
    return { kept: false, reason: "sampled-out" };
  }

  /** 采样元数据写入事件（计划 §7.3：采样配置必须写入事件元数据）。 */
  function metadata() {
    return { rate, strategy: SAMPLING_STRATEGY, errors_always_sample: Boolean(errorsAlwaysSample) };
  }

  return { decide, metadata };
}
