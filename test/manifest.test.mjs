import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 发布包一致性契约测试（计划 §16：README、schema、配置样例、CHANGELOG 和
 * 发布包一致；DSH bundle 契约对齐 repo-scanner 既有规则）。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("bundle manifest: package.json declares dsh.bundle.patch and a loadable main", () => {
  const patchPath = pkg.dsh?.bundle?.patch;
  assert.ok(patchPath, "package.json must declare dsh.bundle.patch");
  assert.ok(existsSync(join(root, patchPath)), `dsh.bundle.patch target not found: ${patchPath}`);
  assert.ok(pkg.main, "package.json must declare main");
  assert.ok(existsSync(join(root, pkg.main)), `main entry not found: ${pkg.main}`);
  assert.equal(pkg.exports?.["."], pkg.main, 'exports "." must resolve to the plugin entry');
});

test("bundle manifest: cordis.patch.yml uses the config-tree insert format", () => {
  const raw = readFileSync(join(root, pkg.dsh.bundle.patch), "utf8");
  assert.match(raw, /-\s+insert:/, 'manifest must be a config-tree patch: "- insert:" list');
  assert.match(raw, new RegExp(`id:\\s*${pkg.name}`), "insert row id must identify this plugin");
  assert.match(raw, new RegExp(`name:\\s*${pkg.name}`), "insert row name must identify this plugin");
  assert.doesNotMatch(raw, /^\s*entry:\s*|\bversion:\s*\d/, "manifest must not use the rejected name/version/entry schema");
});

test("skill frontmatter: SKILL.md declares kebab-case name matching dir + non-empty description", () => {
  const skillsDir = join(root, "skills");
  assert.ok(existsSync(skillsDir), "skills/ directory must exist");
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  assert.ok(dirs.length > 0, "at least one skill must ship");
  for (const dir of dirs) {
    const file = join(skillsDir, dir, "SKILL.md");
    assert.ok(existsSync(file), `SKILL.md missing for skill ${dir}`);
    const raw = readFileSync(file, "utf8");
    assert.match(raw, /^---\n/, `${dir}: frontmatter required at file head`);
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(match, `${dir}: frontmatter block must close`);
    const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    assert.ok(name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name), `${dir}: name must be kebab-case`);
    assert.equal(name, dir, `${dir}: frontmatter name must match directory`);
    assert.ok(description && description.length > 10, `${dir}: description must be non-empty`);
  }
});

test("files whitelist: every declared publish path exists", () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(root, entry)), `files whitelist entry missing on disk: ${entry}`);
  }
});

test("files whitelist: core runtime modules are covered", () => {
  const whitelist = pkg.files.join("\n");
  for (const required of ["plugin/index.js", "cordis.patch.yml", "skills/", "src", "bin", "web", "docs", "examples"]) {
    assert.ok(whitelist.includes(required), `files whitelist must include ${required}`);
  }
});

test("version consistency: package.json matches CHANGELOG release and report tool version", () => {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`## ${pkg.version.replace(/\./g, "\\.")}`), `CHANGELOG must document ${pkg.version}`);
  const aggregate = readFileSync(join(root, "src", "aggregate.mjs"), "utf8");
  assert.ok(aggregate.includes(`version: "${pkg.version}"`), "aggregate.mjs tool.version must match package version");
});

test("docs presence: README, schema doc, configuration doc, config sample, price sample", () => {
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE", "docs/schema.md", "docs/configuration.md", "examples/telemetry.json", "examples/prices.json", "DSH-TELEMETRY-开发计划.md"]) {
    assert.ok(existsSync(join(root, file)), `missing required doc: ${file}`);
  }
});

test("plan document records feasibility review and phase completion", () => {
  const plan = readFileSync(join(root, "DSH-TELEMETRY-开发计划.md"), "utf8");
  assert.ok(/## 0\. 可行性审查/.test(plan), "plan should have feasibility review section");
  assert.ok(/技术可行性/.test(plan), "feasibility review should include technical feasibility");
  assert.ok(/隐私与安全设计/.test(plan), "feasibility review should include privacy design");
  assert.ok(/性能与可靠性/.test(plan), "feasibility review should include performance");
  assert.ok(/数据一致性/.test(plan), "feasibility review should include data consistency");
  assert.ok(/结论.*技术可行/.test(plan), "feasibility review should include conclusion");
  // Phase 0-2 已完成，Phase 3-5 已合并到 v0.1.0
  assert.ok(/Phase 0.*已完成/.test(plan), "plan should record Phase 0 completion");
  assert.ok(/Phase 1.*已完成/.test(plan), "plan should record Phase 1 completion");
  assert.ok(/Phase 2.*已完成/.test(plan), "plan should record Phase 2 completion");
  assert.ok(/Phase 3-5.*已合并.*v0\.1\.0/.test(plan), "plan should record Phase 3-5 merged into v0.1.0");
});
