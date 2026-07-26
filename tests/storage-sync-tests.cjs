"use strict";

const assert = require("node:assert/strict");

require("../scripts/templates.js");
require("../scripts/core.js");
const storageApi = require("../scripts/storage.js");
const PT = globalThis.PaperTools;

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function fakeLocalStorage() {
  const values = new Map();
  return {
    values,
    get length() {
      return values.size;
    },
    key(index) {
      return Array.from(values.keys())[index] || null;
    },
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

async function withLocalStorage(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = fakeLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  try {
    await run(storage);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
}

test("DB v2は既存storeを残して同期sidecarだけを追加する", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const created = [];
  const indexes = [];
  const existing = new Set(["projects", "settings"]);
  const fakeDb = {
    objectStoreNames: {
      contains(name) {
        return existing.has(name);
      },
    },
    createObjectStore(name, options) {
      created.push([name, options]);
      existing.add(name);
      return {
        createIndex(indexName, keyPath, indexOptions) {
          indexes.push([name, indexName, keyPath, indexOptions]);
        },
      };
    },
    close() {},
  };
  const openCalls = [];
  const fakeIndexedDb = {
    open(name, version) {
      openCalls.push([name, version]);
      const request = {};
      queueMicrotask(() => {
        request.result = fakeDb;
        request.onupgradeneeded();
        request.onsuccess();
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    value: fakeIndexedDb,
    configurable: true,
    writable: true,
  });
  try {
    const repository = new PT.Repository();
    await repository.init();
    assert.deepEqual(openCalls, [[storageApi.DB_NAME, 2]]);
    assert.deepEqual(created.map((item) => item[0]), ["syncMeta", "syncOutbox"]);
    assert.deepEqual(
      indexes.filter((item) => item[0] === "syncMeta").map((item) => item[1]),
      ["ownerId", "localProjectId"],
    );
    assert.deepEqual(
      indexes.filter((item) => item[0] === "syncOutbox").map((item) => item[1]),
      ["ownerId", "createdAt"],
    );
    assert.equal(repository.mode, "indexeddb");
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});

test("同期metaはownerごとに分離し部分更新と添付ID重複除去を行う", async () => {
  const repository = new PT.Repository();
  repository.mode = "memory";
  const first = await repository.saveSyncMeta("user-a", "project_1", {
    remoteProjectId: "project_1",
    cloudId: "550e8400-e29b-41d4-a716-446655440000",
    revision: 4,
    fingerprint: `sha256:${"a".repeat(64)}`,
    lastSyncedAt: "2026-07-20T01:02:03+09:00",
    status: "synced",
    syncedAssetIds: ["asset-1", "asset-1", "asset-2"],
  });
  assert.equal(first.remoteProjectId, "project_1");
  assert.equal(first.cloudId, "550e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual(first.syncedAssetIds, ["asset-1", "asset-2"]);
  assert.equal(first.lastSyncedAt, "2026-07-19T16:02:03.000Z");

  await repository.saveSyncMeta("user-b", "project_1", {
    cloudId: "remote-2",
    status: "pending",
  });
  const changed = await repository.saveSyncMeta("user-a", "project_1", {
    status: "conflict",
    error: "revision mismatch\u0000",
  });
  assert.equal(changed.revision, 4);
  assert.equal(changed.remoteProjectId, "project_1");
  assert.equal(changed.cloudId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(changed.error, "revision mismatch");
  assert.deepEqual(changed.syncedAssetIds, ["asset-1", "asset-2"]);
  assert.deepEqual((await repository.listSyncMeta("user-a")).map((item) => item.ownerId), ["user-a"]);
  assert.equal((await repository.listSyncMeta("user-b")).length, 1);
  const cloudDetached = await repository.saveSyncMeta("user-a", "project_1", { cloudId: null });
  assert.equal(cloudDetached.cloudId, null);
  assert.equal(cloudDetached.remoteProjectId, "project_1");
  const remoteDetached = await repository.saveSyncMeta("user-a", "project_1", {
    remoteProjectId: null,
    cloudId: "550e8400-e29b-41d4-a716-446655440001",
  });
  assert.equal(remoteDetached.remoteProjectId, null);
  assert.equal(remoteDetached.cloudId, "550e8400-e29b-41d4-a716-446655440001");

  await repository.deleteSyncMeta("user-a", "project_1");
  assert.equal(await repository.getSyncMeta("user-a", "project_1"), null);
  assert.equal((await repository.listSyncMeta("user-b")).length, 1);
});

test("同期入力はID・status・revision・fingerprint・添付件数を厳格に拒否する", () => {
  assert.throws(
    () => storageApi.normalizeSyncMeta("__proto__", "project_1", {}, null),
    /ユーザID/,
  );
  assert.throws(
    () => storageApi.normalizeSyncMeta("user-a", "../project", {}, null),
    /project ID/,
  );
  assert.throws(
    () => storageApi.normalizeSyncMeta("user-a", "project_1", { status: "complete" }, null),
    /status/,
  );
  assert.throws(
    () => storageApi.normalizeSyncMeta("user-a", "project_1", { revision: "2" }, null),
    /revision/,
  );
  assert.throws(
    () => storageApi.normalizeSyncMeta("user-a", "project_1", { fingerprint: "<script>" }, null),
    /fingerprint/,
  );
  assert.throws(
    () => storageApi.normalizeSyncMeta("user-a", "project_1", {
      syncedAssetIds: Array.from({ length: storageApi.MAX_SYNCED_ASSET_IDS + 1 }, (_, index) => `asset-${index}`),
    }, null),
    /syncedAssetIds/,
  );
  assert.notEqual(
    storageApi.makeSyncMetaKey("user:a", "project_1"),
    storageApi.makeSyncMetaKey("user", "a:project_1"),
  );
});

test("既知フィールドだけを保存してprototype汚染を持ち込まない", () => {
  const malicious = JSON.parse(
    '{"status":"synced","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  );
  const normalized = storageApi.normalizeSyncMeta("user-a", "project_1", malicious, null);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(normalized, "__proto__"), false);
  assert.equal(Object.hasOwn(normalized, "constructor"), false);
  assert.deepEqual(
    Object.keys(normalized).sort(),
    [
      "cloudId",
      "error",
      "fingerprint",
      "key",
      "lastSyncedAt",
      "localProjectId",
      "ownerId",
      "remoteProjectId",
      "revision",
      "status",
      "syncedAssetIds",
      "updatedAt",
    ].sort(),
  );
});

test("outboxはowner別にFIFO列挙し複合keyで安全に削除する", async () => {
  const repository = new PT.Repository();
  repository.mode = "memory";
  const first = await repository.enqueueSyncOperation("user-a", {
    id: "outbox-1",
    operation: "upsert-project",
    localProjectId: "project_1",
    remoteProjectId: "project_1",
    cloudId: "550e8400-e29b-41d4-a716-446655440000",
    revision: 2,
    fingerprint: "hash-one",
    size: 1024,
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const second = await repository.enqueueSyncOperation("user-a", {
    id: "outbox-2",
    operation: "upload-asset",
    localProjectId: "project_1",
    assetId: "asset-1",
    size: 2048,
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  await repository.enqueueSyncOperation("user-b", {
    id: "outbox-1",
    operation: "delete-project",
    localProjectId: "project_2",
  });
  assert.equal(first.ownerId, "user-a");
  assert.equal(first.remoteProjectId, "project_1");
  assert.equal(first.cloudId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(second.assetId, "asset-1");
  assert.deepEqual(
    (await repository.listSyncOutbox("user-a")).map((item) => item.id),
    ["outbox-1", "outbox-2"],
  );
  await repository.deleteSyncOutboxItem("user-a", "outbox-1");
  assert.deepEqual((await repository.listSyncOutbox("user-a")).map((item) => item.id), ["outbox-2"]);
  assert.deepEqual((await repository.listSyncOutbox("user-b")).map((item) => item.id), ["outbox-1"]);
});

test("outboxは未知操作・不正status・過大サイズ・添付ID欠落を拒否する", () => {
  const base = {
    id: "outbox-1",
    operation: "upsert-project",
    localProjectId: "project_1",
  };
  assert.throws(
    () => storageApi.normalizeSyncOutboxItem("user-a", { ...base, operation: "execute-script" }),
    /operation/,
  );
  assert.throws(
    () => storageApi.normalizeSyncOutboxItem("user-a", { ...base, status: "synced" }),
    /status/,
  );
  assert.throws(
    () => storageApi.normalizeSyncOutboxItem("user-a", {
      ...base,
      size: storageApi.MAX_OUTBOX_ITEM_BYTES + 1,
    }),
    /サイズ/,
  );
  assert.throws(
    () => storageApi.normalizeSyncOutboxItem("user-a", {
      ...base,
      operation: "upload-asset",
    }),
    /asset ID/,
  );
});

test("localStorage fallbackでも別Repositoryからowner別sidecarを復元できる", async () => {
  await withLocalStorage(async () => {
    const first = new PT.Repository();
    first.mode = "localstorage";
    await first.saveSyncMeta("user-a", "project_1", {
      cloudId: "remote-1",
      status: "synced",
      syncedAssetIds: ["asset-1"],
    });
    await first.enqueueSyncOperation("user-a", {
      id: "outbox-1",
      operation: "upsert-project",
      localProjectId: "project_1",
      size: 12,
    });

    const reloaded = new PT.Repository();
    reloaded.mode = "localstorage";
    assert.equal((await reloaded.listSyncMeta("user-a"))[0].cloudId, "remote-1");
    assert.deepEqual((await reloaded.listSyncMeta("user-b")), []);
    assert.equal((await reloaded.listSyncOutbox("user-a"))[0].size, 12);
    await reloaded.deleteSyncOutboxItem("user-a", "outbox-1");

    const afterDelete = new PT.Repository();
    afterDelete.mode = "localstorage";
    assert.deepEqual(await afterDelete.listSyncOutbox("user-a"), []);
  });
});

test("端末project保存はoutboxやネットワーク完了を条件にしない", async () => {
  const repository = new PT.Repository();
  repository.mode = "memory";
  const project = PT.createProject("generic-ja", { title: "端末優先保存" });
  const saved = await repository.saveProject(project);
  assert.equal((await repository.getProject(saved.id)).title, "端末優先保存");
  assert.deepEqual(await repository.listSyncOutbox("user-a"), []);
});

test("クラウド取得は端末版の保存時刻が変わった場合に原子的上書きを拒否する", async () => {
  const repository = new PT.Repository();
  repository.mode = "memory";
  const original = await repository.saveProject(
    PT.createProject("generic-ja", { title: "端末版" }),
  );
  const remote = PT.deepClone(original);
  remote.title = "クラウド版";

  await assert.rejects(
    repository.replaceProjectIfUnchanged(remote, "2000-01-01T00:00:00.000Z"),
    (error) => error && error.code === "local-project-changed",
  );
  assert.equal((await repository.getProject(original.id)).title, "端末版");

  const replaced = await repository.replaceProjectIfUnchanged(remote, original.updatedAt);
  assert.equal(replaced.title, "クラウド版");
  assert.equal((await repository.getProject(original.id)).title, "クラウド版");

  const created = PT.createProject("generic-ja", { title: "新規取得" });
  const inserted = await repository.replaceProjectIfUnchanged(created, null);
  assert.equal((await repository.getProject(inserted.id)).title, "新規取得");
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
  process.stdout.write(`\n${passed}/${tests.length} storage sync tests passed.\n`);
  if (passed !== tests.length) process.exitCode = 1;
})();
