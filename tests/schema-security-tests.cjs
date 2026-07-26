"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.resolve(__dirname, "..", "supabase", "schema.sql"), "utf8");
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function functionBody(name) {
  const match = schema.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`,
    "i",
  ));
  assert.ok(match, `${name} が見つかりません`);
  return match[0];
}

test("projectsはRLSを強制しブラウザーへSELECTだけを付与する", () => {
  assert.match(schema, /alter table public\.projects enable row level security/i);
  assert.match(schema, /alter table public\.projects force row level security/i);
  assert.match(schema, /revoke all on table public\.projects from public, anon, authenticated/i);
  assert.match(schema, /grant select on table public\.projects to authenticated/i);
  assert.doesNotMatch(schema, /grant\s+(insert|update|delete)[\s(]/i);
});

test("保存RPCはSECURITY DEFINERでも所有者と版番号を明示検査する", () => {
  const body = functionBody("save_project");
  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /v_owner_id uuid := \(select auth\.uid\(\)\)/i);
  assert.match(body, /p\.owner_id = v_owner_id/i);
  assert.match(body, /p\.revision = expected_revision/i);
  assert.match(body, /on conflict \(owner_id, project_id\) do nothing/i);
});

test("保存RPCと制約はpayloadのID・型・4MiB上限を強制する", () => {
  const body = functionBody("save_project");
  assert.match(body, /jsonb_typeof\(new_payload\) <> 'object'/i);
  assert.match(body, /jsonb_extract_path_text\(new_payload, 'id'\)[\s\S]*distinct from p_project_id/i);
  assert.match(body, /octet_length\(new_payload::text\) > 4194304/i);
  assert.match(schema, /constraint projects_payload_max_bytes check/i);
  assert.match(schema, /constraint projects_payload_project_id_matches check/i);
});

test("削除RPCは行ロック・revision・明示的な空assetsをすべて要求する", () => {
  const body = functionBody("delete_project");
  assert.match(body, /for update/i);
  assert.match(body, /if v_revision <> expected_revision/i);
  assert.match(body, /if not v_assets_empty/i);
  assert.match(body, /'attachments_present'::text/i);
  assert.match(body, /jsonb_typeof\([\s\S]*?'assets'[\s\S]*?\) = 'array'/i);
  assert.match(body, /jsonb_array_length\(/i);
});

test("RPC実行権限はauthenticatedだけへ限定する", () => {
  for (const signature of [
    "public.save_project(text, bigint, jsonb)",
    "public.delete_project(text, bigint)",
  ]) {
    const escaped = signature.replace(/[().]/g, "\\$&");
    assert.match(schema, new RegExp(`revoke all on function ${escaped}\\s+from public, anon, authenticated`, "i"));
    assert.match(schema, new RegExp(`grant execute on function ${escaped}\\s+to authenticated`, "i"));
  }
});

test("Storageはprivateかつ本人の固定パスだけを許可する", () => {
  assert.match(schema, /values\s*\(\s*'paper-assets',\s*'paper-assets',\s*false/i);
  assert.match(schema, /owner_id = \(\(select auth\.uid\(\)\)::text\)/i);
  assert.match(schema, /cardinality\(storage\.foldername\(name\)\) = 3/i);
  assert.match(schema, /p\.cloud_id::text = \(storage\.foldername\(name\)\)\[2\]/i);
  assert.match(schema, /storage\.filename\(name\)[\s\S]*?\^payload\\\./i);
});

test("Storageは50MiB・MIME許可リスト・添付UUID階層をDB側でも強制する", () => {
  assert.match(schema, /file_size_limit[\s\S]*?52428800/i);
  for (const mime of [
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/csv",
    "application/json",
    "text/plain",
    "application/yaml",
  ]) {
    assert.ok(schema.includes(`'${mime}'`), `${mime} が許可リストにありません`);
  }
  assert.match(
    schema,
    /\(storage\.foldername\(name\)\)\[3\]\s*~\*\s*'\^\[0-9a-f\]\{8\}-/i,
  );
  assert.match(schema, /\[1-5\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}/i);
});

test("初期版StorageはSELECTとINSERTだけで上書き・削除policyを残さない", () => {
  assert.match(schema, /create policy paper_assets_select_own/i);
  assert.match(schema, /create policy paper_assets_insert_own/i);
  assert.doesNotMatch(schema, /create policy paper_assets_(update|delete)_own/i);
  assert.match(schema, /drop policy if exists paper_assets_update_own/i);
  assert.match(schema, /drop policy if exists paper_assets_delete_own/i);
});

test("トランザクションと末尾改行を保持する", () => {
  assert.match(schema, /^\s*--[\s\S]*?\bbegin;/i);
  assert.match(schema, /\bcommit;\s*$/i);
  assert.ok(schema.endsWith("\n"));
});

let passed = 0;
for (const item of tests) {
  try {
    item.run();
    passed += 1;
    process.stdout.write(`PASS ${item.name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${item.name}\n${error.stack || error.message}\n`);
  }
}
process.stdout.write(`\n${passed}/${tests.length} schema security tests passed.\n`);
if (passed !== tests.length) process.exitCode = 1;
