/**
 * dsh-local-telemetry — JSONL sink（计划 §6.3 / §7 / §8.1）。
 *
 * 行为契约：
 * - 追加写，一行一个完整事件；写入串行化，不产生半行 JSON；
 * - fail-open：任何写盘失败只计数并本地告警（节流），绝不抛给调用方；
 * - 队列上限（默认 1000）：满时丢弃新到事件并计数（明确的丢弃策略）；
 * - 批量落盘：batch_size 条或 flush_interval_ms 触发；
 * - 单事件 > 64KB 丢弃计数；坏 JSON / 校验失败丢弃计数；
 * - 按事件 UTC 日期分文件 `<date>.jsonl`，超过 max_file_mb 轮转为
 *   `<date>.part-NNN.jsonl`；
 * - 计数器持久化到 `<dir>/meta.json`；保留期清理删除过期日期文件。
 */

import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_EVENT_BYTES, serializeEvent, validateEvent } from "./schema.mjs";

const META_FILE = "meta.json";

export class JsonlSink {
  /**
   * @param {object} opts
   * @param {string} opts.dir 数据目录（逐日 JSONL 所在）
   * @param {number} [opts.maxFileBytes] 单文件上限（默认 100MB）
   * @param {number} [opts.batchCount] 批量大小（默认 100）
   * @param {number} [opts.flushIntervalMs] 定时 flush（默认 1000）
   * @param {number} [opts.maxQueue] 队列上限（默认 1000）
   * @param {number} [opts.retentionDays] 启动时后台应用的保留期（0/undefined = 不自动清理）
   * @param {() => number} [opts.now] 可注入时钟（测试）
   */
  constructor({
    dir,
    maxFileBytes = 100 * 1024 * 1024,
    batchCount = 100,
    flushIntervalMs = 1000,
    maxQueue = 1000,
    retentionDays = 0,
    now = () => Date.now(),
  } = {}) {
    if (!dir || typeof dir !== "string") throw new TypeError("JsonlSink requires dir");
    this.dir = dir;
    this.maxFileBytes = Math.max(1024, maxFileBytes);
    this.batchCount = Math.max(1, Math.round(batchCount));
    this.flushIntervalMs = Math.max(50, Math.round(flushIntervalMs));
    this.maxQueue = Math.max(1, Math.round(maxQueue));
    this.retentionDays = retentionDays;
    this.now = now;

    this.queue = [];
    this.counters = {
      written: 0,
      dropped_queue: 0,
      dropped_oversize: 0,
      dropped_invalid: 0,
      dropped_write: 0,
      sampled_out: 0,
    };
    this.lastWriteError = null;
    this._warnedWriteError = false;
    this._metaDirty = false;
    this._closed = false;
    this._chain = Promise.resolve(); // 串行写链，保证无半行 JSON
    this._timer = null;
    this._started = false;
  }

  /** 惰性启动：建目录、恢复计数器、起定时器、后台清理保留期。 */
  async start() {
    if (this._started) return;
    this._started = true;
    try {
      await mkdir(this.dir, { recursive: true });
    } catch {
      /* fail-open：写事件时再试 */
    }
    await this._loadMeta();
    this._timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    if (this.retentionDays > 0) {
      void this.purge({ olderThanMs: this.retentionDays * 86_400_000 }).catch(() => {});
    }
  }

  /** 入队一条已构造好的事件；任何失败只计数（fail-open）。 */
  write(event) {
    if (this._closed) return { ok: false, reason: "sink_closed" };
    const check = validateEvent(event);
    if (!check.ok) {
      this.counters.dropped_invalid += 1;
      this._metaDirty = true;
      return { ok: false, reason: "invalid_event", errors: check.errors };
    }
    let line;
    try {
      line = serializeEvent(event);
    } catch {
      this.counters.dropped_invalid += 1;
      this._metaDirty = true;
      return { ok: false, reason: "invalid_event" };
    }
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
      this.counters.dropped_oversize += 1;
      this._metaDirty = true;
      return { ok: false, reason: "oversize" };
    }
    if (this.queue.length >= this.maxQueue) {
      this.counters.dropped_queue += 1;
      this._metaDirty = true;
      return { ok: false, reason: "queue_full" };
    }
    this.queue.push({ line, date: utcDateOf(event.timestamp), bytes: Buffer.byteLength(line, "utf8") + 1 });
    if (this.queue.length >= this.batchCount) void this.flush();
    return { ok: true };
  }

  /** 外部丢弃计数（如采样丢弃），进入同一份持久化账本。 */
  countDropped(kind) {
    if (kind === undefined || kind === null) return;
    const key = kind === "sampled_out" ? "sampled_out" : `dropped_${kind}`;
    if (key in this.counters) {
      this.counters[key] += 1;
      this._metaDirty = true;
    }
  }

  /** 把当前队列快照落盘；串行链上执行，失败 fail-open。 */
  async flush() {
    await this._chain; // 先等在途写完（write 触发的批量 flush 可能仍在执行）
    if (this._closed) return this._drainMeta();
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length > 0) {
      this._chain = this._chain
        .then(() => this._appendBatch(batch))
        .catch(() => {
          // 防御：链上任何未预期异常不得外泄
          this.counters.dropped_write += batch.length;
          this._metaDirty = true;
        });
      await this._chain;
    }
    return this._drainMeta();
  }

  async _appendBatch(batch) {
    try {
      if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    } catch {
      /* 继续尝试写入 */
    }
    const byDate = new Map();
    for (const item of batch) {
      if (!byDate.has(item.date)) byDate.set(item.date, []);
      byDate.get(item.date).push(item);
    }
    for (const [date, items] of byDate) {
      await this._appendDateBatch(date, items);
    }
  }

  /**
   * 按日期分块写入：逐事件检查容量，溢出即轮转到下一个 part 文件。
   * 连续落在同一目标的行合并为单次 append，避免半行 JSON 也减少系统调用。
   */
  async _appendDateBatch(date, items) {
    const sizes = new Map();
    try {
      for (const name of await readdir(this.dir)) {
        if (!name.startsWith(`${date}.`) || !name.endsWith(".jsonl")) continue;
        try {
          sizes.set(name, (await stat(join(this.dir, name))).size);
        } catch {
          /* 忽略瞬时消失的文件 */
        }
      }
    } catch {
      /* 目录尚不存在：写入时会再试 */
    }
    let currentName = null;
    let currentSize = 0;
    let buffer = [];
    let bufferBytes = 0;

    const flushBuffer = async () => {
      if (buffer.length === 0 || currentName === null) {
        buffer = [];
        bufferBytes = 0;
        return;
      }
      const payload = buffer.map((item) => item.line).join("\n") + "\n";
      try {
        await appendFile(join(this.dir, currentName), payload, "utf8");
        this.counters.written += buffer.length;
        currentSize += bufferBytes;
        sizes.set(currentName, currentSize);
        this._warnedWriteError = false;
      } catch (error) {
        this.counters.dropped_write += buffer.length;
        this._metaDirty = true;
        this.lastWriteError = String(error?.code ?? error?.message ?? error);
        this._localWarn();
      }
      buffer = [];
      bufferBytes = 0;
    };

    for (const item of items) {
      const needNewTarget =
        currentName === null || (currentSize + bufferBytes + item.bytes > this.maxFileBytes && currentSize + bufferBytes > 0);
      if (needNewTarget) {
        await flushBuffer();
        currentName = this._pickTarget(date, item.bytes, sizes);
        currentSize = sizes.get(currentName) ?? 0;
      }
      buffer.push(item);
      bufferBytes += item.bytes;
      if (currentSize + bufferBytes >= this.maxFileBytes) {
        await flushBuffer(); // 当前文件已到上限，下次写入将轮转
      }
    }
    await flushBuffer();
  }

  /** 选择目标文件名：`<date>.jsonl` 优先，已满则寻找/新建 `<date>.part-NNN.jsonl`。 */
  _pickTarget(date, bytes, sizes) {
    const base = `${date}.jsonl`;
    if (!sizes.has(base) || sizes.get(base) + bytes <= this.maxFileBytes) return base;
    for (let index = 1; index <= 9999; index += 1) {
      const name = `${date}.part-${String(index).padStart(3, "0")}.jsonl`;
      if (!sizes.has(name) || sizes.get(name) + bytes <= this.maxFileBytes) return name;
    }
    return base; // 兜底：交给写失败计数
  }

  _localWarn() {
    if (this._warnedWriteError) return;
    this._warnedWriteError = true;
    // 本地告警：仅 stderr，一次性，不阻塞业务
    console.warn?.(`[dsh-local-telemetry] telemetry write failed (${this.lastWriteError}); events will be dropped until it recovers`);
  }

  async _loadMeta() {
    try {
      if (!existsSync(join(this.dir, META_FILE))) return;
      const meta = JSON.parse(await readFile(join(this.dir, META_FILE), "utf8"));
      if (meta && typeof meta.counters === "object") {
        for (const [key, value] of Object.entries(meta.counters)) {
          if (key in this.counters && Number.isInteger(value) && value >= 0) this.counters[key] = value;
        }
      }
    } catch {
      /* 计数器丢失可接受 */
    }
  }

  async _drainMeta() {
    if (!this._metaDirty) return;
    try {
      if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
      const meta = { version: 1, updated_at: new Date(this.now()).toISOString(), counters: { ...this.counters } };
      await writeFile(join(this.dir, META_FILE), JSON.stringify(meta, null, 2), "utf8");
      this._metaDirty = false;
    } catch {
      /* 计数持久化失败不影响主流程 */
    }
  }

  /** 文件级状态（CLI --status / Web UI）。 */
  async status() {
    let files = [];
    let totalBytes = 0;
    try {
      const names = (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl")).sort();
      for (const name of names) {
        const info = await stat(join(this.dir, name));
        files.push({ name, bytes: info.size, mtime: info.mtimeMs });
        totalBytes += info.size;
      }
    } catch {
      files = [];
    }
    return {
      store: "jsonl",
      dir: this.dir,
      files,
      total_bytes: totalBytes,
      counters: { ...this.counters },
      last_write_error: this.lastWriteError,
    };
  }

  /**
   * 保留期清理。
   * @param {{ olderThanMs?: number, beforeMs?: number }} opts 二选一：
   *   olderThanMs（相对现在回溯）或 beforeMs（绝对截止 epoch ms）。
   * @returns {{ removed_files: number, removed_bytes: number }}
   */
  async purge({ olderThanMs = null, beforeMs = null } = {}) {
    const now = this.now();
    const cutoff = beforeMs ?? (olderThanMs !== null ? now - olderThanMs : null);
    if (cutoff === null) throw new TypeError("purge requires olderThanMs or beforeMs");
    const cutoffDate = utcDateOf(new Date(cutoff).toISOString());
    let removedFiles = 0;
    let removedBytes = 0;
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return { removed_files: 0, removed_bytes: 0 };
    }
    for (const name of names) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})(?:\.part-\d+)?\.jsonl$/);
      if (!match) continue;
      if (match[1] >= cutoffDate) continue; // 日期字符串可直接比较
      const path = join(this.dir, name);
      try {
        const info = await stat(path);
        await unlink(path);
        removedFiles += 1;
        removedBytes += info.size;
      } catch {
        /* 单文件失败不中断 */
      }
    }
    this._metaDirty = true;
    await this._drainMeta();
    return { removed_files: removedFiles, removed_bytes: removedBytes };
  }

  /** 关闭：flush 后停表；flush 失败不阻塞退出（fail-open）。 */
  async close() {
    if (this._closed) return;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    try {
      await this.flush();
    } catch {
      /* ignore */
    }
    this._closed = true;
    this._metaDirty = true;
    try {
      await this._drainMeta();
    } catch {
      /* ignore */
    }
  }
}

/** 事件 timestamp（ISO UTC）→ `YYYY-MM-DD`。 */
export function utcDateOf(isoTimestamp) {
  const value = typeof isoTimestamp === "string" ? isoTimestamp : "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}
