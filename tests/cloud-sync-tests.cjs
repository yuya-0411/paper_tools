"use strict";

const assert = require("node:assert/strict");

require("../scripts/templates.js");
require("../scripts/core.js");
const cloudApi = require("../scripts/cloud-sync.js");
const PT = globalThis.PaperTools;
const USER_UUID = "11111111-1111-4111-8111-111111111111";
const CLOUD_UUID = "22222222-2222-4222-8222-222222222222";
const ASSET_UUID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = `asset_${ASSET_UUID}`;

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function publishableKey() {
  return "sb_publishable_" + "A".repeat(32);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function legacyKey(role) {
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ role, iss: "supabase" })}.signature`;
}

function config(extra = {}) {
  return Object.assign({
    enabled: true,
    url: "https://paper-tools.supabase.co",
    publishableKey: publishableKey(),
    allowedRedirectOrigins: ["https://papers.example.com"],
  }, extra);
}

function fixture() {
  const project = PT.createProject("generic-ja", { title: "クラウド同期テスト" });
  project.title = "クラウド同期テスト";
  project.research.objective = "複数端末で安全に原稿を編集する。";
  project.manuscript.sections[0].content = "端末をまたいで保存する原稿。";
  return project;
}

function makeMock(options = {}) {
  const calls = [];
  const fixedUser = options.user || {
    id: USER_UUID,
    email: "author@example.com",
    email_confirmed_at: "2026-07-20T00:00:00.000Z",
    last_sign_in_at: "2026-07-21T00:00:00.000Z",
  };
  const fixedSession = options.session === null ? null : Object.assign({
    user: fixedUser,
    access_token: "MUST_NOT_ESCAPE",
    refresh_token: "MUST_NOT_ESCAPE",
    expires_at: 1800000000,
  }, options.session || {});
  let authListener = null;

  function authResponse(name, payload) {
    calls.push({ area: "auth", name, payload });
    if (typeof options.authResponse === "function") return options.authResponse(name, payload, fixedSession);
    if (name === "signOut") return Promise.resolve({ data: {}, error: null });
    if (name === "getSession") return Promise.resolve({ data: { session: fixedSession }, error: null });
    return Promise.resolve({ data: { user: fixedUser, session: fixedSession }, error: null });
  }

  class Builder {
    constructor(table) {
      this.state = {
        table,
        action: null,
        payload: null,
        columns: null,
        filters: [],
        order: null,
        limit: null,
        resultMode: null,
      };
    }

    select(columns) {
      if (!this.state.action) this.state.action = "select";
      this.state.columns = columns;
      return this;
    }

    insert(payload) {
      this.state.action = "insert";
      this.state.payload = payload;
      return this;
    }

    update(payload) {
      this.state.action = "update";
      this.state.payload = payload;
      return this;
    }

    delete() {
      this.state.action = "delete";
      return this;
    }

    eq(column, value) {
      this.state.filters.push([column, value]);
      return this;
    }

    order(column, value) {
      this.state.order = [column, value];
      return this;
    }

    limit(value) {
      this.state.limit = value;
      return this;
    }

    single() {
      this.state.resultMode = "single";
      return this;
    }

    maybeSingle() {
      this.state.resultMode = "maybeSingle";
      return this;
    }

    then(resolve, reject) {
      const snapshot = JSON.parse(JSON.stringify(this.state));
      calls.push({ area: "query", state: snapshot });
      let response;
      try {
        response = typeof options.queryResponse === "function"
          ? options.queryResponse(snapshot)
          : { data: null, error: null };
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
      return Promise.resolve(response).then(resolve, reject);
    }
  }

  const storageBucket = {
    upload(path, data, uploadOptions) {
      calls.push({
        area: "storage",
        name: "upload",
        path,
        size: data.size === undefined ? data.byteLength : data.size,
        options: uploadOptions,
      });
      return Promise.resolve(options.uploadResponse || { data: { path }, error: null });
    },
    download(path) {
      calls.push({ area: "storage", name: "download", path });
      const blob = options.downloadData || new Blob(["downloaded"], { type: "text/plain" });
      return Promise.resolve(options.downloadResponse || { data: blob, error: null });
    },
    remove(paths) {
      calls.push({ area: "storage", name: "remove", paths: paths.slice() });
      return Promise.resolve(options.removeResponse || { data: paths, error: null });
    },
  };

  const client = {
    auth: {
      getSession: () => authResponse("getSession"),
      signInWithOtp: (payload) => authResponse("signInWithOtp", payload),
      signInWithPassword: (payload) => authResponse("signInWithPassword", payload),
      signUp: (payload) => authResponse("signUp", payload),
      verifyOtp: (payload) => authResponse("verifyOtp", payload),
      signOut: (payload) => authResponse("signOut", payload),
      onAuthStateChange(listener) {
        calls.push({ area: "auth", name: "onAuthStateChange" });
        authListener = listener;
        return {
          data: {
            subscription: {
              unsubscribe() {
                calls.push({ area: "auth", name: "unsubscribe" });
              },
            },
          },
        };
      },
    },
    from(table) {
      return new Builder(table);
    },
    rpc(name, payload) {
      calls.push({ area: "rpc", name, payload });
      if (typeof options.rpcResponse === "function") {
        return Promise.resolve(options.rpcResponse(name, payload));
      }
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from(bucket) {
        calls.push({ area: "storage", name: "from", bucket });
        return storageBucket;
      },
    },
  };

  return {
    calls,
    client,
    emitAuth(event, session = fixedSession) {
      if (!authListener) throw new Error("No auth listener");
      authListener(event, session);
    },
  };
}

function installSdk(mock) {
  const createCalls = [];
  globalThis.supabase = {
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return mock.client;
    },
  };
  return createCalls;
}

function remoteRow(project, revision = 1) {
  return {
    cloud_id: CLOUD_UUID,
    project_id: project.id,
    payload: cloudApi.sanitizeProjectForCloud(project),
    revision,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  };
}

test("CommonJSとPaperTools名前空間へ同じAPIを公開する", () => {
  assert.equal(PT.createCloudSync, cloudApi.createCloudSync);
  assert.equal(PT.sanitizeProjectForCloud, cloudApi.sanitizeProjectForCloud);
  assert.equal(PT.CloudConflictError, cloudApi.CloudConflictError);
  assert.equal(Object.isFrozen(cloudApi.CLOUD_SCHEMA), true);
  assert.equal(cloudApi.CLOUD_SCHEMA.ownerColumn, "owner_id");
  assert.equal(cloudApi.CLOUD_SCHEMA.saveProjectRpc, "save_project");
});

test("未設定時はSDKに触れず完全に無効になる", async () => {
  let created = 0;
  globalThis.supabase = { createClient() { created += 1; } };
  const sync = cloudApi.createCloudSync({ enabled: false });
  assert.equal(created, 0);
  assert.deepEqual(sync.getStatus(), {
    enabled: false,
    ready: false,
    url: null,
    keyKind: null,
    projectsTable: "projects",
    attachmentsBucket: "paper-assets",
    requiresRls: true,
  });
  await assert.rejects(() => sync.listProjects(), (error) => error.code === "cloud-disabled");
  assert.equal(created, 0);
});

test("同期無効でもキー欄へ誤入力した秘密キーを拒否する", () => {
  assert.throws(
    () => cloudApi.normalizeCloudConfig({
      enabled: false,
      publishableKey: "sb_secret_" + "A".repeat(40),
    }),
    (error) => error.code === "unsafe-key",
  );
  assert.throws(
    () => cloudApi.normalizeCloudConfig({
      enabled: false,
      anonKey: legacyKey("service_role"),
    }),
    (error) => error.code === "unsafe-key",
  );
  assert.deepEqual(
    cloudApi.normalizeCloudConfig({ enabled: false, publishableKey: "   " }),
    { enabled: false },
  );
});

test("同期有効時にSDKがなければローカル利用を壊さない明示エラーを返す", () => {
  delete globalThis.supabase;
  assert.throws(
    () => cloudApi.createCloudSync(config()),
    (error) => error.code === "sdk-unavailable" && !String(error.message).includes(publishableKey()),
  );
});

test("file://などHTTPS以外の画面では同期を有効化しない", () => {
  const previous = globalThis.location;
  let created = 0;
  globalThis.location = { protocol: "file:", origin: "null" };
  globalThis.supabase = { createClient() { created += 1; } };
  try {
    assert.throws(
      () => cloudApi.createCloudSync(config()),
      (error) => error.code === "insecure-origin",
    );
    assert.equal(created, 0);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test("公開HTTPS URLとpublishableまたはanonキーだけを許可する", () => {
  assert.equal(cloudApi.normalizeCloudConfig(config()).keyKind, "publishable");
  assert.equal(cloudApi.normalizeCloudConfig(config({ publishableKey: undefined, anonKey: legacyKey("anon") })).keyKind, "anon");

  const unsafe = [
    config({ url: "http://paper-tools.supabase.co" }),
    config({ url: "https://localhost:54321" }),
    config({ publishableKey: "sb_secret_" + "A".repeat(40) }),
    config({ publishableKey: legacyKey("service_role") }),
    config({ publishableKey: undefined, serviceRoleKey: "administrator-secret" }),
    config({ publishableKey: "unvalidated-browser-key" }),
    config({ attachmentsBucket: "public-files" }),
    config({ projectsTable: "other_projects" }),
  ];
  unsafe.forEach((value) => {
    assert.throws(() => cloudApi.normalizeCloudConfig(value), cloudApi.CloudSyncError);
  });
});

test("初期化は明示的に有効化した一度だけで通信処理を開始しない", () => {
  const mock = makeMock();
  const createCalls = installSdk(mock);
  const tabValues = new Map();
  const tabStorage = {
    getItem: (key) => tabValues.get(key) || null,
    setItem: (key, value) => tabValues.set(key, value),
    removeItem: (key) => tabValues.delete(key),
  };
  const sync = cloudApi.createCloudSync(config({ sessionStorage: tabStorage }));
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].url, "https://paper-tools.supabase.co");
  assert.equal(createCalls[0].key, publishableKey());
  assert.equal(createCalls[0].options.auth.persistSession, true);
  assert.equal(createCalls[0].options.auth.autoRefreshToken, true);
  assert.equal(createCalls[0].options.auth.detectSessionInUrl, true);
  createCalls[0].options.auth.storage.setItem("token", "tab-only");
  assert.equal(tabValues.get("paper_tools_auth_session_token"), "tab-only");
  assert.equal(createCalls[0].options.auth.storage.getItem("token"), "tab-only");
  assert.equal(mock.calls.length, 0);
  assert.equal(sync.getStatus().ready, true);
  assert.equal(Object.hasOwn(sync.getStatus(), "key"), false);
});

test("Auth APIはメールリンク・パスワード・OTPを検証しトークンを外へ返さない", async () => {
  const mock = makeMock();
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());

  const otpResult = await sync.signInWithEmailOtp(" Author@Example.com ", {
    redirectTo: "https://papers.example.com/auth/callback",
    shouldCreateUser: false,
  });
  assert.equal(otpResult.user.email, "author@example.com");
  assert.equal(otpResult.session.signedIn, true);
  assert.equal(JSON.stringify(otpResult).includes("MUST_NOT_ESCAPE"), false);
  const otpCall = mock.calls.find((item) => item.name === "signInWithOtp");
  assert.deepEqual(otpCall.payload, {
    email: "author@example.com",
    options: {
      emailRedirectTo: "https://papers.example.com/auth/callback",
      shouldCreateUser: false,
    },
  });
  await sync.signInWithEmailOtp("author@example.com");
  const defaultOtpCall = mock.calls.filter((item) => item.name === "signInWithOtp").at(-1);
  assert.equal(defaultOtpCall.payload.options.shouldCreateUser, false);

  await sync.signInWithPassword("author@example.com", "correct horse battery staple");
  await sync.signUp("new@example.com", "eight-characters", {
    redirectTo: "https://papers.example.com/welcome",
  });
  await sync.verifyEmailOtp("author@example.com", "123456", "email");
  const session = await sync.getSession();
  assert.deepEqual(Object.keys(session), ["signedIn", "user", "expiresAt"]);
  assert.equal(Object.hasOwn(session, "access_token"), false);

  await assert.rejects(
    () => sync.signInWithEmailOtp("not-an-email"),
    (error) => error.code === "invalid-email",
  );
  await assert.rejects(
    () => sync.signInWithPassword("author@example.com", "short"),
    (error) => error.code === "invalid-password",
  );
  await assert.rejects(
    () => sync.signInWithEmailOtp("author@example.com", { redirectTo: "https://evil.example.net/" }),
    (error) => error.code === "invalid-redirect",
  );
});

test("認証監視は明示購読時だけ動き秘密トークンを通知しない", () => {
  const mock = makeMock();
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  const events = [];
  const unsubscribe = sync.subscribeAuth((event) => events.push(event));
  mock.emitAuth("SIGNED_IN");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "SIGNED_IN");
  assert.equal(events[0].session.user.id, USER_UUID);
  assert.equal(JSON.stringify(events[0]).includes("MUST_NOT_ESCAPE"), false);
  unsubscribe();
  assert.ok(mock.calls.some((item) => item.name === "unsubscribe"));
});

test("クラウド用プロジェクトは添付本体・未知フィールド・権限フィールドを除去し入力を変更しない", () => {
  const project = fixture();
  project.assets.push({
    id: "asset-safe",
    name: "results.csv",
    type: "text/csv",
    size: 7,
    data: new Blob(["a,b\n1,2"]),
  });
  project.history.push({
    id: "history-1",
    user_id: "attacker-controlled",
    owner_id: "other-user",
    access_token: "secret-token",
    project: { title: "過去版", assets: [{ data: new Uint8Array([1, 2, 3]) }] },
  });
  project.unknownTopLevel = "remove-me";
  const originalAsset = project.assets[0].data;
  const safe = cloudApi.sanitizeProjectForCloud(project);
  assert.equal(safe.assets[0].data, null);
  assert.equal(project.assets[0].data, originalAsset);
  assert.equal(Object.hasOwn(safe, "unknownTopLevel"), false);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("attacker-controlled"), false);
  assert.equal(serialized.includes("other-user"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("同じ安全化済み内容はキー順に依存しないSHA-256指紋になる", async () => {
  const project = fixture();
  const reordered = Object.assign({}, project, {
    research: Object.fromEntries(Object.entries(project.research).reverse()),
  });
  const firstJson = cloudApi.canonicalProjectJson(project);
  const secondJson = cloudApi.canonicalProjectJson(reordered);
  assert.equal(firstJson, secondJson);
  const first = await cloudApi.fingerprintProjectForCloud(project);
  const second = await cloudApi.fingerprintProjectForCloud(reordered);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  reordered.title = "内容が変更された原稿";
  assert.notEqual(await cloudApi.fingerprintProjectForCloud(reordered), first);
});

test("認証保存先としてlocalStorageを直接注入できない", () => {
  const previous = globalThis.localStorage;
  const persistentStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
  try {
    globalThis.localStorage = persistentStorage;
    assert.throws(
      () => cloudApi.createSessionStorageAdapter(persistentStorage),
      (error) => error.code === "unsafe-auth-storage",
    );
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test("projects CRUDはRLS前提で所有者IDを送らずrevisionを比較する", async () => {
  const project = fixture();
  const mock = makeMock({
    queryResponse() {
      return { data: remoteRow(project, 2), error: null };
    },
    rpcResponse(name, payload) {
      if (name === "save_project") {
        return {
          data: [{
            status: "saved",
            cloud_id: CLOUD_UUID,
            revision: payload.expected_revision + 1,
            updated_at: "2026-07-21T00:00:00.000Z",
          }],
          error: null,
        };
      }
      return {
        data: [{ status: "deleted", cloud_id: CLOUD_UUID, revision: 2 }],
        error: null,
      };
    },
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());

  const created = await sync.createProject(project);
  assert.equal(created.revision, 1);
  const updated = await sync.updateProject(project, 1);
  assert.equal(updated.revision, 2);
  const deleted = await sync.deleteProject(project.id, 2);
  assert.equal(deleted.deleted, true);
  assert.equal(created.cloudId, CLOUD_UUID);

  const rpcCalls = mock.calls.filter((item) => item.area === "rpc");
  assert.deepEqual(Object.keys(rpcCalls[0].payload).sort(), ["expected_revision", "new_payload", "p_project_id"]);
  assert.equal(rpcCalls[0].payload.expected_revision, 0);
  assert.equal(rpcCalls[1].payload.expected_revision, 1);
  assert.deepEqual(rpcCalls[2].payload, {
    p_project_id: project.id,
    expected_revision: 2,
  });
  assert.equal(JSON.stringify(rpcCalls).includes("owner_id"), false);
  assert.equal(JSON.stringify(rpcCalls).includes("user_id"), false);
});

test("一覧と単体取得は件数制限・ID一致・安全な復元を行う", async () => {
  const project = fixture();
  const row = remoteRow(project, 4);
  const mock = makeMock({
    queryResponse(query) {
      if (query.resultMode === "maybeSingle") return { data: row, error: null };
      return { data: [row], error: null };
    },
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  const list = await sync.listProjects({ limit: 9999 });
  assert.equal(list.length, 1);
  assert.equal(list[0].revision, 4);
  assert.equal(list[0].cloudId, CLOUD_UUID);
  const loaded = await sync.getProject(project.id);
  assert.equal(loaded.project.title, project.title);
  const listQuery = mock.calls.find((item) => item.area === "query" && !item.state.resultMode).state;
  assert.equal(listQuery.limit, cloudApi.CLOUD_LIMITS.maxProjectsPerRequest);
  assert.deepEqual(listQuery.order, ["updated_at", { ascending: false }]);
  const getQuery = mock.calls.find((item) => item.area === "query" && item.state.resultMode).state;
  assert.deepEqual(getQuery.filters, [["project_id", project.id]]);
});

test("revision不一致または重複作成を競合として扱う", async () => {
  const project = fixture();
  const conflictMock = makeMock({
    queryResponse() {
      return { data: remoteRow(project, 5), error: null };
    },
    rpcResponse() {
      return {
        data: [{ status: "conflict", cloud_id: CLOUD_UUID, revision: 5 }],
        error: null,
      };
    },
  });
  installSdk(conflictMock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.updateProject(project, 2),
    (error) => (
      error instanceof cloudApi.CloudConflictError &&
      error.code === "revision-conflict" &&
      error.details.latest.revision === 5
    ),
  );
  await assert.rejects(
    () => sync.createProject(project),
    (error) => error instanceof cloudApi.CloudConflictError,
  );
});

test("未ログインではprojectsとStorageへ到達しない", async () => {
  const mock = makeMock({ session: null });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(() => sync.listProjects(), (error) => error.code === "not-authenticated");
  assert.equal(mock.calls.some((item) => item.area === "query"), false);
  assert.equal(mock.calls.some((item) => item.area === "storage"), false);
});

test("添付アップロードは署名・サイズ・MIME・安全な固定パスを検証する", async () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
  ]);
  const mock = makeMock();
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  const uploaded = await sync.uploadAttachment(CLOUD_UUID, {
    id: ASSET_ID,
    name: "結果図.png",
    type: "image/png",
    size: pngBytes.byteLength,
    data: new Blob([pngBytes], { type: "image/png" }),
    user_id: "attacker-user",
  });
  assert.equal(uploaded.path, `${USER_UUID}/${CLOUD_UUID}/${ASSET_UUID}/payload.png`);
  assert.equal(uploaded.cloudId, CLOUD_UUID);
  assert.equal(uploaded.type, "image/png");
  const upload = mock.calls.find((item) => item.name === "upload");
  assert.equal(upload.path.includes("attacker-user"), false);
  assert.equal(upload.path.includes("project-safe"), false);
  assert.equal(upload.path.includes("結果図"), false);
  assert.deepEqual(upload.options, {
    contentType: "image/png",
    cacheControl: "0",
    upsert: false,
  });
});

test("アップロード応答を失っても同じ不変オブジェクトなら安全に再開する", async () => {
  const contents = "idempotent attachment";
  const mock = makeMock({
    uploadResponse: {
      data: null,
      error: { code: "409", message: "The resource already exists" },
    },
    downloadData: new Blob([contents], { type: "text/plain" }),
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  const result = await sync.uploadAttachment(CLOUD_UUID, {
    id: ASSET_ID,
    name: "notes.txt",
    type: "text/plain",
    size: contents.length,
    data: new Blob([contents], { type: "text/plain" }),
  });
  assert.equal(result.recoveredExisting, true);
  assert.equal(mock.calls.filter((item) => item.name === "upload").length, 1);
  assert.equal(mock.calls.filter((item) => item.name === "download").length, 1);
});

test("同じ添付IDに別内容がある場合は上書きせず再添付を要求する", async () => {
  const mock = makeMock({
    uploadResponse: {
      data: null,
      error: { code: "409", message: "The resource already exists" },
    },
    downloadData: new Blob(["different"], { type: "text/plain" }),
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.uploadAttachment(CLOUD_UUID, {
      id: ASSET_ID,
      name: "notes.txt",
      type: "text/plain",
      data: new Blob(["local"], { type: "text/plain" }),
    }),
    (error) => error.code === "attachment-content-conflict",
  );
});

test("危険・不整合・未対応の添付を通信前に拒否する", async () => {
  const cases = [
    {
      asset: { id: ASSET_ID, name: "../secret.txt", type: "text/plain", data: new Blob(["safe"]) },
      code: "unsafe-attachment-name",
    },
    {
      asset: { id: ASSET_ID, name: "active.svg", type: "image/svg+xml", data: new Blob(["<svg/>"]) },
      code: "unsafe-attachment-type",
    },
    {
      asset: { id: ASSET_ID, name: "fake.png", type: "image/png", data: new Blob(["not-png"]) },
      code: "invalid-binary-signature",
    },
    {
      asset: { id: ASSET_ID, name: "data.json", type: "application/json", data: new Blob(["{bad"]) },
      code: "invalid-json-attachment",
    },
    {
      asset: { id: ASSET_ID, name: "data.csv", type: "text/csv", size: 999, data: new Blob(["a,b"]) },
      code: "attachment-size-mismatch",
    },
    {
      asset: { id: ASSET_ID, name: "data.txt", type: "application/pdf", data: new Blob(["text"]) },
      code: "attachment-type-mismatch",
    },
    {
      asset: { id: ASSET_ID, name: "data.txt", type: "text/plain", data: "not-binary" },
      code: "invalid-binary",
    },
    {
      asset: { id: "asset-legacy", name: "data.txt", type: "text/plain", data: new Blob(["text"]) },
      code: "legacy-attachment-id",
    },
  ];
  for (const item of cases) {
    const mock = makeMock();
    installSdk(mock);
    const sync = cloudApi.createCloudSync(config());
    await assert.rejects(
      () => sync.uploadAttachment(CLOUD_UUID, item.asset),
      (error) => error.code === item.code,
    );
    assert.equal(mock.calls.some((call) => call.name === "upload"), false);
  }
});

test("既存添付のupsert上書きを禁止して再添付を要求する", async () => {
  const mock = makeMock();
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.uploadAttachment(CLOUD_UUID, {
      id: ASSET_ID,
      name: "data.txt",
      type: "text/plain",
      data: new Blob(["updated"]),
    }, { upsert: true }),
    (error) => error.code === "unsafe-attachment-overwrite",
  );
  assert.equal(mock.calls.some((item) => item.name === "upload"), false);
});

test("添付ダウンロードも認証ユーザー由来の固定パスとサイズ上限を使う", async () => {
  const mock = makeMock({ downloadData: new Blob(["a,b\n1,2"], { type: "text/csv" }) });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  const result = await sync.downloadAttachment(CLOUD_UUID, {
    id: ASSET_ID,
    name: "results.csv",
    type: "text/csv",
  });
  assert.equal(result.path, `${USER_UUID}/${CLOUD_UUID}/${ASSET_UUID}/payload.csv`);
  assert.equal(await result.data.text(), "a,b\n1,2");
  assert.equal(result.data.type, "text/csv");
  assert.equal(result.type, "text/csv");
  const download = mock.calls.find((item) => item.name === "download");
  assert.equal(download.path, result.path);
});

test("ダウンロード応答のMIME不一致を拒否する", async () => {
  const mock = makeMock({
    downloadData: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.downloadAttachment(CLOUD_UUID, {
      id: ASSET_ID,
      name: "notes.txt",
      type: "text/plain",
    }),
    (error) => error.code === "invalid-download",
  );
});

test("添付ありプロジェクトの削除はデータ損失を避けて変更前に停止する", async () => {
  const project = fixture();
  project.assets.push({
    id: ASSET_ID,
    name: "results.csv",
    type: "text/csv",
    size: 10,
    lastModified: 1700000000000,
    data: null,
  });
  const mock = makeMock({
    queryResponse() {
      return { data: remoteRow(project, 3), error: null };
    },
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.deleteProject(project.id, 3),
    (error) => error.code === "attachments-block-delete",
  );
  assert.equal(mock.calls.some((item) => item.name === "remove"), false);
  assert.equal(mock.calls.some((item) => item.area === "rpc"), false);
});

test("削除RPCがattachments_presentを返した場合も安全エラーへ統一する", async () => {
  const project = fixture();
  const mock = makeMock({
    queryResponse() {
      return { data: remoteRow(project, 4), error: null };
    },
    rpcResponse(name) {
      assert.equal(name, "delete_project");
      return {
        data: [{ status: "attachments_present", cloud_id: CLOUD_UUID, revision: 5 }],
        error: null,
      };
    },
  });
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config());
  await assert.rejects(
    () => sync.deleteProject(project.id, 4),
    (error) => error.code === "attachments-block-delete",
  );
  assert.equal(mock.calls.filter((item) => item.area === "rpc").length, 1);
  assert.equal(mock.calls.some((item) => item.name === "remove"), false);
});

test("プロジェクトサイズ上限と不正IDを保存前に拒否する", async () => {
  const project = fixture();
  project.manuscript.sections[0].content = "長い原稿".repeat(30000);
  const mock = makeMock();
  installSdk(mock);
  const sync = cloudApi.createCloudSync(config({ maxProjectBytes: 64 * 1024 }));
  await assert.rejects(
    () => sync.createProject(project),
    (error) => error.code === "project-too-large",
  );
  const validProject = fixture();
  validProject.id = "../other-project";
  await assert.rejects(
    () => sync.createProject(validProject),
    (error) => error.code === "invalid-id",
  );
  assert.equal(mock.calls.some((item) => item.area === "query"), false);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    const started = Date.now();
    try {
      await item.run();
      process.stdout.write(`PASS ${item.name} (${Date.now() - started} ms)\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`FAIL ${item.name}\n${error.stack || error.message}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed}/${tests.length} cloud-sync tests passed.\n`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
