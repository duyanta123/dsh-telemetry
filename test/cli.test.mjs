import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "bin", "telemetry.mjs");
const fixtureData = join(root, "test", "fixtures", "telemetry-data");

// cpSync 递归复制在 Windows 非 ASCII 路径下触发 Node 崩溃（0xC0000409），改用逐条目复制
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(src, entry.name), join(dest, entry.name));
    else copyFileSync(join(src, entry.name), join(dest, entry.name));
  }
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message) };
  }
}

test("cli: --help exits 0 with usage", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("--summary"));
  assert.ok(stdout.includes("--purge"));
});

test("cli: no args exits 2 with usage on stdout", async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 2);
  assert.ok(stdout.includes("dsh-local-telemetry"));
});

test("cli: --status reports jsonl store and zero counters for fixture", async () => {
  const { code, stdout } = await runCli(["--status", "--path", fixtureData]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Store: jsonl"));
  assert.ok(stdout.includes("Files: 1"));
  assert.ok(stdout.includes("written=0"));
});

test("cli: --status --json is machine-parseable", async () => {
  const { code, stdout } = await runCli(["--status", "--path", fixtureData, "--json"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.store, "jsonl");
  assert.equal(parsed.files.length, 1);
});

test("cli: --summary text matches plan §9.1 shape and recomputable numbers", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Requests        3"), stdout);
  assert.ok(stdout.includes("Success         2 (66.7%)"));
  assert.ok(stdout.includes("Errors          0"));
  assert.ok(stdout.includes("Cancelled       1"));
  assert.ok(stdout.includes("P95 latency     9100ms (n=3, nearest-rank)"));
  assert.ok(stdout.includes("Input tokens    5,400"));
  assert.ok(stdout.includes("Tool calls      2"));
  assert.ok(stdout.includes("estimate, not a bill"));
});

test("cli: --summary --json exposes full aggregate structure", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData, "--json"]);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.requests.total, 3);
  assert.equal(summary.requests.retries, 1);
  assert.equal(summary.models.length, 2);
  assert.equal(summary.data_completeness.events, 21);
});

test("cli: --summary --group-by model outputs grouped rows", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData, "--group-by", "model"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Grouped by model:"));
  assert.ok(stdout.includes("deepseek-chat"));
  assert.ok(stdout.includes("deepseek-reasoner"));
});

test("cli: --summary --errors-only filters to failure events", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData, "--errors-only", "--json"]);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.data_completeness.events, 2);
});

test("cli: --summary --slow-over-ms 8500 keeps only slow traces", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData, "--slow-over-ms", "8500", "--json"]);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.requests.total, 1); // 仅 trace-002 (9100ms)；8100ms 未达标
});

test("cli: --summary --since filters by window", async () => {
  const { code, stdout } = await runCli(["--summary", "--path", fixtureData, "--since", "2026-08-23T12:06:00.000Z", "--json"]);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.requests.total, 1); // 只有 trace-003 (12:10) 在窗口内
  assert.equal(summary.requests.cancelled, 1);
});

test("cli: --trace prints span tree and timeline", async () => {
  const { code, stdout } = await runCli(["--trace", "trace-001", "--path", fixtureData]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("Trace trace-001"));
  assert.ok(stdout.includes("span-001"));
  assert.ok(stdout.includes("Timeline:"));
  assert.ok(stdout.includes("request.started"));
});

test("cli: --trace --json returns tree structure", async () => {
  const { code, stdout } = await runCli(["--trace", "trace-002", "--path", fixtureData, "--json"]);
  assert.equal(code, 0);
  const view = JSON.parse(stdout);
  assert.equal(view.trace_id, "trace-002");
  assert.equal(view.timeline.length, 6);
  assert.equal(view.tree.roots.length, 1);
});

test("cli: --trace unknown id exits 1", async () => {
  const { code, stderr } = await runCli(["--trace", "no-such-trace", "--path", fixtureData]);
  assert.equal(code, 1);
  assert.ok(stderr.includes("no events found"));
});

test("cli: --export writes json and markdown files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-cli-"));
  const jsonPath = join(dir, "summary.json");
  const mdPath = join(dir, "TELEMETRY-REPORT.md");
  const r1 = await runCli(["--summary", "--path", fixtureData, "--export", jsonPath]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.ok(existsSync(jsonPath));
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.requests.total, 3);

  const r2 = await runCli(["--summary", "--path", fixtureData, "--export", mdPath, "--format", "markdown"]);
  assert.equal(r2.code, 0, r2.stderr);
  const md = readFileSync(mdPath, "utf8");
  assert.ok(md.includes("# Harness 遥测报告"));
  assert.ok(md.includes("## 4. Token 与成本"));
  assert.ok(md.includes("## 附录"));
});

test("cli: --purge --before removes old files only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-purge-cli-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  copyDir(fixtureData, dataDir);
  const oldFile = join(dataDir, "2026-07-01.jsonl");
  await import("node:fs/promises").then((fs) => fs.writeFile(oldFile, "{}\n", "utf8"));
  const { code, stdout } = await runCli(["--purge", "--before", "30d", "--path", dataDir, "--json"]);
  assert.equal(code, 0, stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.removed_files, 1);
  assert.ok(existsSync(join(dataDir, "2026-08-23.jsonl")));
});

test("cli: --purge without --before is a usage error", async () => {
  const { code, stderr } = await runCli(["--purge", "--path", fixtureData]);
  assert.equal(code, 2);
  assert.ok(stderr.includes("--before"));
});

test("cli: --config bad file degrades to disabled with warning on stderr", async () => {
  const { code, stderr } = await runCli(["--status", "--path", fixtureData, "--config", join("Z:", "missing", "telemetry.json")]);
  assert.equal(code, 0); // status 查询本身可用；配置降级不崩溃
  assert.ok(stderr.includes("config"));
});

test("cli: invalid --group-by exits 2", async () => {
  const { code } = await runCli(["--summary", "--path", fixtureData, "--group-by", "galaxy"]);
  assert.equal(code, 2);
});
