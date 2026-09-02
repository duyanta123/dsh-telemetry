import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor, hashName, getOrCreateSalt, defaultPrivacy, SECRET_FIELDS } from "../src/privacy.mjs";

const redactor = () => createRedactor({ absolutePaths: "basename", salt: "test-salt" });

test("privacy: Authorization / bearer tokens redacted", () => {
  const r = redactor();
  const out = r.redactString("Authorization: Bearer abc123def456 and Cookie: session=xyz789");
  assert.equal(out.includes("abc123def456"), false);
  assert.equal(out.includes("xyz789"), false);
  assert.ok(out.includes("[redacted:authorization]"));
  assert.ok(r.summary().rules.includes("authorization"));
});

test("privacy: URL userinfo credentials redacted", () => {
  const r = redactor();
  const out = r.redactString("git remote: https://user:ghp_TOKEN123@git.example.com/repo.git");
  assert.equal(out.includes("ghp_TOKEN123"), false);
  assert.ok(out.includes("[redacted:url_credentials]"));
});

test("privacy: URL query tokens redacted", () => {
  const r = redactor();
  const out = r.redactString("GET https://api.example.com/v1/data?token=supersecret123&page=2");
  assert.equal(out.includes("supersecret123"), false);
  assert.ok(out.includes("page=2"));
  assert.ok(out.includes("[redacted:url_query_token]"));
});

test("privacy: inline secret field=value patterns redacted with field-name rule", () => {
  const r = redactor();
  const out = r.redactString('config uses api_key: "sk-abc123456789" and password=hunter2');
  assert.equal(out.includes("sk-abc123456789"), false);
  assert.equal(out.includes("hunter2"), false);
  const rules = r.summary().rules;
  assert.ok(rules.includes("api_key"), rules.join(","));
  assert.ok(rules.includes("password"), rules.join(","));
});

test("privacy: absolute paths reduced to basename (default)", () => {
  const r = redactor();
  const out = r.redactString("read from C:\\Users\\duyan\\secret-project\\src\\app.ts ok");
  assert.equal(out.includes("duyan"), false);
  assert.ok(out.includes("app.ts"));
  assert.ok(r.summary().rules.includes("absolute_path"));
});

test("privacy: custom rules applied by name", () => {
  const r = createRedactor({
    customRules: [{ name: "employee_id", regex: /EMP-\d+/g }],
    salt: "s",
  });
  const out = r.redactString("employee EMP-12345 onboarded");
  assert.equal(out.includes("EMP-12345"), false);
  assert.ok(out.includes("[redacted:employee_id]"));
});

test("privacy: metadata secret keys dropped entirely; numbers kept; strings redacted", () => {
  const r = redactor();
  const { value, redactions, rules } = r.redactMetadata({
    input_bytes: 4096,
    output_bytes: 512,
    ok: true,
    api_key: "sk-should-not-survive",
    url: "https://user:pass@host.example.com/x",
    path: "/home/dev/secret/file.txt",
    nested: { deep: "content" },
  });
  assert.equal(value.api_key, undefined); // 整键丢弃
  assert.equal(value.input_bytes, 4096);
  assert.equal(value.ok, true);
  assert.equal(value.url.includes("pass"), false);
  assert.equal(value.path, "file.txt");
  assert.equal(value.nested, undefined); // 嵌套结构不透传
  assert.ok(redactions >= 3);
  assert.ok(rules.includes("api_key"));
  assert.ok(rules.includes("nested_metadata_dropped"));
});

test("privacy: per-call redaction counts are relative, not cumulative", () => {
  const r = redactor();
  const first = r.redactMetadata({ api_key: "a", token: "b" });
  const second = r.redactMetadata({ input_bytes: 1 });
  assert.equal(first.redactions, 2);
  assert.equal(second.redactions, 0);
  assert.deepEqual(second.rules, []);
});

test("privacy: hashName stable per salt, differs across salts, irreversible", () => {
  const a1 = hashName("deepseek-chat", "salt-one");
  const a2 = hashName("deepseek-chat", "salt-one");
  const b1 = hashName("deepseek-chat", "salt-two");
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
  assert.match(a1, /^h:[0-9a-f]{16}$/);
  assert.equal(hashName("", "salt"), "");
});

test("privacy: salt file created once and reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tel-salt-"));
  const salt1 = getOrCreateSalt(dir);
  const salt2 = getOrCreateSalt(dir);
  assert.equal(salt1, salt2);
  assert.match(readFileSync(join(dir, ".salt"), "utf8").trim(), /^[0-9a-f]{32}$/);
  assert.ok(existsSync(join(dir, ".salt")));
});

test("privacy: defaultPrivacy block marks content_captured=false", () => {
  assert.deepEqual(defaultPrivacy(), { content_captured: false, redactions: 0, rules: [] });
});

test("privacy: built-in secret field list covers plan §6.2", () => {
  for (const field of ["authorization", "cookie", "token", "password", "secret", "api_key"]) {
    assert.ok(SECRET_FIELDS.includes(field), field);
  }
});
