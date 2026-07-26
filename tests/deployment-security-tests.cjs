"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

require("../scripts/templates.js");
require("../scripts/core.js");
const cloudApi = require("../scripts/cloud-sync.js");

const rootDirectory = path.resolve(__dirname, "..");
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function read(relativePath) {
  return fs.readFileSync(path.join(rootDirectory, relativePath), "utf8");
}

function decodedJwtRole(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : "";
  } catch {
    return "";
  }
}

function deployedTextSources() {
  const roots = ["index.html", "assets", "scripts", "docs", "supabase"];
  const files = [];
  function visit(target) {
    const absolute = path.join(rootDirectory, target);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      fs.readdirSync(absolute).forEach((name) => visit(path.join(target, name)));
      return;
    }
    const bytes = fs.readFileSync(absolute);
    if (!bytes.includes(0)) files.push([target, bytes.toString("utf8")]);
  }
  roots.forEach(visit);
  return files;
}

test("公開設定に管理者キー・秘密鍵・DB接続文字列を含めない", () => {
  const source = read("scripts/cloud-config.js");
  deployedTextSources().forEach(([name, text]) => {
    assert.doesNotMatch(text, /sb_secret_[A-Za-z0-9_-]{16,}/i, `${name}にSecret keyがあります`);
    assert.doesNotMatch(
      text,
      /(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s"'`]+/i,
      `${name}にDB接続文字列があります`,
    );
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${name}に秘密鍵があります`);
    const jwtCandidates = text.match(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
    jwtCandidates.forEach((candidate) => {
      assert.notEqual(decodedJwtRole(candidate), "service_role", `${name}にservice_role JWTがあります`);
    });
  });

  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, {
    filename: "scripts/cloud-config.js",
    timeout: 1_000,
  });
  const configured = sandbox.window.PAPER_TOOLS_CLOUD;
  assert.ok(configured && Object.prototype.toString.call(configured) === "[object Object]");
  assert.equal(Object.isFrozen(configured), true);
  Object.values(configured).forEach((value) => {
    assert.ok(["boolean", "string", "number"].includes(typeof value) || value == null);
  });

  // normalizeCloudConfig validates publishable/anon keys even while disabled,
  // so an accidentally pasted service key fails before the Pages deploy job.
  cloudApi.normalizeCloudConfig(JSON.parse(JSON.stringify(configured)));
});

test("同期有効時はCSPの接続先を設定したSupabase originだけへ狭める", () => {
  const source = read("scripts/cloud-config.js");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { timeout: 1_000 });
  const configured = JSON.parse(JSON.stringify(sandbox.window.PAPER_TOOLS_CLOUD));
  const normalized = cloudApi.normalizeCloudConfig(configured);
  const html = read("index.html");
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s);
  assert.ok(match, "index.htmlにContent Security Policyが必要です");
  const csp = match[1];
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'self'/);
  if (!normalized.enabled) return;

  const configuredOrigin = new URL(normalized.url).origin;
  assert.ok(
    csp.split(/\s+/).includes(configuredOrigin),
    `connect-srcへ${configuredOrigin}を追加してください`,
  );
  assert.doesNotMatch(
    csp,
    /https:\/\/\*\.supabase\.co/,
    "同期有効時はSupabaseのワイルドカード接続先を残さないでください",
  );
});

test("GitHub Actionsを可変タグではなく完全なcommit SHAへ固定する", () => {
  const workflowDirectory = path.join(rootDirectory, ".github", "workflows");
  const workflows = fs.readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/i.test(name));
  assert.ok(workflows.length > 0);
  workflows.forEach((name) => {
    const source = fs.readFileSync(path.join(workflowDirectory, name), "utf8");
    const actions = Array.from(source.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm));
    actions.forEach((match) => {
      if (match[1].startsWith("./")) return;
      assert.match(
        match[2],
        /^[0-9a-f]{40}$/i,
        `${name}の${match[1]}を完全なcommit SHAへ固定してください`,
      );
    });
  });
});

test("同梱Supabase SDKが検証済みSHA384と一致する", () => {
  const bytes = fs.readFileSync(
    path.join(rootDirectory, "scripts", "vendor", "supabase-2.110.8.min.js"),
  );
  const digest = crypto.createHash("sha384").update(bytes).digest("hex");
  assert.equal(
    digest,
    "4ef7bc3be0ba3c1cec20c2bf2110b01db8bc7f21335c8948b3a39f541647b9ba65c1885a405ff8333c6a820fa9a7fa32",
  );
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack || error.message}\n`);
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} deployment security tests passed.\n`);
  if (passed !== tests.length) process.exitCode = 1;
})();
