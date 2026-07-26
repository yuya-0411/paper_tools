(function (root, factory) {
  "use strict";
  const api = factory(root);
  root.PaperTools = Object.assign(root.PaperTools || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DB_NAME = "paper_tools_static";
  const DB_VERSION = 2;
  const PROJECTS_STORE = "projects";
  const SETTINGS_STORE = "settings";
  const SYNC_META_STORE = "syncMeta";
  const SYNC_OUTBOX_STORE = "syncOutbox";
  const FALLBACK_PROJECTS_KEY = "paper_tools_projects_v1";
  const FALLBACK_SETTINGS_KEY = "paper_tools_settings_v1";
  const FALLBACK_SYNC_META_KEY = "paper_tools_sync_meta_v2";
  const FALLBACK_SYNC_OUTBOX_KEY = "paper_tools_sync_outbox_v2";
  const RECOVERY_PREFIX = "paper_tools_recovery_v1_";
  const MAX_SYNC_RECORDS = 5000;
  const MAX_SYNC_FALLBACK_BYTES = 5 * 1024 * 1024;
  const MAX_SYNCED_ASSET_IDS = 2000;
  const MAX_OUTBOX_ITEM_BYTES = 100 * 1024 * 1024;
  const RESERVED_IDENTIFIERS = new Set(["__proto__", "prototype", "constructor"]);
  const SYNC_STATUSES = Object.freeze([
    "local",
    "queued",
    "pending",
    "syncing",
    "synced",
    "conflict",
    "retry",
    "processing",
    "error",
    "deleted",
    "offline",
  ]);
  const OUTBOX_OPERATIONS = Object.freeze([
    "upsert-project",
    "delete-project",
    "upload-asset",
    "delete-asset",
  ]);
  const SYNC_STATUS_SET = new Set(SYNC_STATUSES);
  const OUTBOX_OPERATION_SET = new Set(OUTBOX_OPERATIONS);
  const OUTBOX_STATUS_SET = new Set(["queued", "pending", "retry", "processing", "error"]);
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function assertPlainRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label}はオブジェクトで指定してください．`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label}に使用できないオブジェクトが指定されました．`);
    }
    return value;
  }

  function normalizeSyncId(value, label, optional) {
    if ((value === null || value === undefined || value === "") && optional) return null;
    if (typeof value !== "string" || value !== value.trim() || value.length > 160) {
      throw new TypeError(`${label}が不正です．`);
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
      || RESERVED_IDENTIFIERS.has(value.toLowerCase())
    ) {
      throw new TypeError(`${label}が不正です．`);
    }
    return value;
  }

  function normalizeSyncStatus(value, fallback) {
    const status = value === undefined || value === null || value === "" ? fallback : value;
    if (typeof status !== "string" || !SYNC_STATUS_SET.has(status)) {
      throw new TypeError("同期statusが不正です．");
    }
    return status;
  }

  function normalizeInteger(value, label, fallback, maximum) {
    const number = value === undefined || value === null ? fallback : value;
    if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
      throw new TypeError(`${label}が不正です．`);
    }
    return number;
  }

  function normalizeTimestamp(value, label, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || value.length > 64) {
      throw new TypeError(`${label}が不正です．`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError(`${label}が不正です．`);
    return date.toISOString();
  }

  function normalizeFingerprint(value) {
    if (value === undefined || value === null || value === "") return null;
    if (
      typeof value !== "string"
      || value.length > 256
      || !/^[A-Za-z0-9][A-Za-z0-9._:+/=-]{0,255}$/.test(value)
    ) {
      throw new TypeError("fingerprintが不正です．");
    }
    return value;
  }

  function normalizeSyncError(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") throw new TypeError("同期errorが不正です．");
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 2000);
  }

  function normalizeSyncedAssetIds(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_SYNCED_ASSET_IDS) {
      throw new TypeError("syncedAssetIdsが不正です．");
    }
    const unique = [];
    const seen = new Set();
    value.forEach((item) => {
      const id = normalizeSyncId(item, "asset ID", false);
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    });
    return unique;
  }

  function makeSyncMetaKey(ownerId, localProjectId) {
    const owner = normalizeSyncId(ownerId, "ユーザID", false);
    const local = normalizeSyncId(localProjectId, "ローカルproject ID", false);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(local)}`;
  }

  function makeSyncOutboxKey(ownerId, outboxId) {
    const owner = normalizeSyncId(ownerId, "ユーザID", false);
    const id = normalizeSyncId(outboxId, "outbox ID", false);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(id)}`;
  }

  function resolveRemoteIds(value, existing) {
    return {
      remoteProjectId: hasOwn(value, "remoteProjectId")
        ? normalizeSyncId(value.remoteProjectId, "remote project ID", true)
        : existing && existing.remoteProjectId || null,
      cloudId: hasOwn(value, "cloudId")
        ? normalizeSyncId(value.cloudId, "cloud ID", true)
        : existing && existing.cloudId || null,
    };
  }

  function normalizeSyncMeta(ownerId, localProjectId, value, existing) {
    const source = assertPlainRecord(value || Object.create(null), "同期メタデータ");
    const owner = normalizeSyncId(ownerId, "ユーザID", false);
    const local = normalizeSyncId(localProjectId, "ローカルproject ID", false);
    if (hasOwn(source, "ownerId") && normalizeSyncId(source.ownerId, "ユーザID", false) !== owner) {
      throw new TypeError("同期メタデータのユーザIDが一致しません．");
    }
    if (
      hasOwn(source, "localProjectId")
      && normalizeSyncId(source.localProjectId, "ローカルproject ID", false) !== local
    ) {
      throw new TypeError("同期メタデータのproject IDが一致しません．");
    }
    const remoteIds = resolveRemoteIds(source, existing);
    const now = new Date().toISOString();
    return {
      key: makeSyncMetaKey(owner, local),
      ownerId: owner,
      localProjectId: local,
      remoteProjectId: remoteIds.remoteProjectId,
      cloudId: remoteIds.cloudId,
      revision: normalizeInteger(
        hasOwn(source, "revision") ? source.revision : existing && existing.revision,
        "revision",
        0,
        2147483647,
      ),
      fingerprint: normalizeFingerprint(
        hasOwn(source, "fingerprint") ? source.fingerprint : existing && existing.fingerprint,
      ),
      lastSyncedAt: normalizeTimestamp(
        hasOwn(source, "lastSyncedAt") ? source.lastSyncedAt : existing && existing.lastSyncedAt,
        "lastSyncedAt",
        null,
      ),
      status: normalizeSyncStatus(
        hasOwn(source, "status") ? source.status : existing && existing.status,
        "local",
      ),
      error: normalizeSyncError(
        hasOwn(source, "error") ? source.error : existing && existing.error,
      ),
      syncedAssetIds: normalizeSyncedAssetIds(
        hasOwn(source, "syncedAssetIds")
          ? source.syncedAssetIds
          : existing && existing.syncedAssetIds,
      ),
      updatedAt: normalizeTimestamp(
        hasOwn(source, "updatedAt") ? source.updatedAt : undefined,
        "updatedAt",
        now,
      ),
    };
  }

  function makeOutboxId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return `outbox_${root.crypto.randomUUID()}`;
    }
    return `outbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function normalizeSyncOutboxItem(ownerId, value) {
    const source = assertPlainRecord(value, "outbox項目");
    const owner = normalizeSyncId(ownerId, "ユーザID", false);
    if (hasOwn(source, "ownerId") && normalizeSyncId(source.ownerId, "ユーザID", false) !== owner) {
      throw new TypeError("outbox項目のユーザIDが一致しません．");
    }
    const id = normalizeSyncId(source.id || makeOutboxId(), "outbox ID", false);
    const localProjectId = normalizeSyncId(source.localProjectId, "ローカルproject ID", false);
    const remoteIds = resolveRemoteIds(source, null);
    const operation = source.operation;
    if (typeof operation !== "string" || !OUTBOX_OPERATION_SET.has(operation)) {
      throw new TypeError("outbox operationが不正です．");
    }
    const assetId = normalizeSyncId(source.assetId, "asset ID", true);
    if ((operation === "upload-asset" || operation === "delete-asset") && !assetId) {
      throw new TypeError("添付操作にはasset IDが必要です．");
    }
    const now = new Date().toISOString();
    const status = normalizeSyncStatus(source.status, "queued");
    if (!OUTBOX_STATUS_SET.has(status)) throw new TypeError("outbox statusが不正です．");
    return {
      key: makeSyncOutboxKey(owner, id),
      id,
      ownerId: owner,
      operation,
      localProjectId,
      remoteProjectId: remoteIds.remoteProjectId,
      cloudId: remoteIds.cloudId,
      assetId,
      revision: normalizeInteger(source.revision, "revision", 0, 2147483647),
      fingerprint: normalizeFingerprint(source.fingerprint),
      status,
      size: normalizeInteger(source.size, "サイズ", 0, MAX_OUTBOX_ITEM_BYTES),
      createdAt: normalizeTimestamp(source.createdAt, "createdAt", now),
      error: normalizeSyncError(source.error),
    };
  }

  function localStorageOrNull() {
    try {
      return root.localStorage || null;
    } catch (_error) {
      return null;
    }
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("保存領域を操作できませんでした．"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("保存に失敗しました．"));
      transaction.onabort = () => reject(transaction.error || new Error("保存が中断されました．"));
    });
  }

  function projectChangedError() {
    const error = new Error("取得中に端末版が変更されたため，クラウド版で上書きしませんでした．もう一度状態を確認してください．");
    error.code = "local-project-changed";
    return error;
  }

  function projectVersion(project) {
    return project && typeof project.updatedAt === "string" ? project.updatedAt : null;
  }

  class Repository {
    constructor() {
      this.db = null;
      this.mode = "initializing";
      this.warning = "";
      this.memoryProjects = new Map();
      this.memorySettings = Object.assign({}, root.PaperTools.DEFAULT_SETTINGS || {});
      this.memorySyncMeta = new Map();
      this.memorySyncOutbox = new Map();
      this.deletedSyncMetaKeys = new Set();
      this.deletedSyncOutboxKeys = new Set();
    }

    async init() {
      if (root.indexedDB) {
        try {
          const request = root.indexedDB.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
              const store = db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
              store.createIndex("updatedAt", "updatedAt", { unique: false });
            }
            if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
              db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(SYNC_META_STORE)) {
              const syncMeta = db.createObjectStore(SYNC_META_STORE, { keyPath: "key" });
              syncMeta.createIndex("ownerId", "ownerId", { unique: false });
              syncMeta.createIndex("localProjectId", "localProjectId", { unique: false });
            }
            if (!db.objectStoreNames.contains(SYNC_OUTBOX_STORE)) {
              const syncOutbox = db.createObjectStore(SYNC_OUTBOX_STORE, { keyPath: "key" });
              syncOutbox.createIndex("ownerId", "ownerId", { unique: false });
              syncOutbox.createIndex("createdAt", "createdAt", { unique: false });
            }
          };
          this.db = await requestAsPromise(request);
          this.db.onversionchange = () => {
            this.db.close();
            this.warning = "別のタブで保存領域が更新されました．このタブを再読み込みしてください．";
          };
          this.mode = "indexeddb";
          return this;
        } catch (error) {
          this.warning = `IndexedDBを利用できませんでした：${error.message}`;
        }
      }
      try {
        const probe = "paper_tools_storage_probe";
        root.localStorage.setItem(probe, "1");
        root.localStorage.removeItem(probe);
        this.mode = "localstorage";
        this.warning = "簡易保存モードです．添付ファイルは再読み込み後に保持されないため，ZIPバックアップを利用してください．";
      } catch (_error) {
        this.mode = "memory";
        this.warning = "ブラウザ保存を利用できません．このタブを閉じる前に必ずJSONまたはZIPを保存してください．";
      }
      return this;
    }

    saveEmergencyProject(project) {
      const storage = localStorageOrNull();
      if (!project || !project.id || !storage) return false;
      try {
        const portable = root.PaperTools.normalizeProject(project);
        portable.assets = portable.assets.map((asset) => Object.assign({}, asset, { data: null }));
        portable.history = [];
        const savedAt = root.PaperTools.nowIso();
        storage.setItem(
          RECOVERY_PREFIX + portable.id,
          JSON.stringify({ savedAt, project: portable }),
        );
        return true;
      } catch (_error) {
        return false;
      }
    }

    clearEmergencyProject(id) {
      const storage = localStorageOrNull();
      if (!id || !storage) return;
      try {
        storage.removeItem(RECOVERY_PREFIX + id);
      } catch (_error) {
        // Recovery storage is best-effort and must not break the primary save.
      }
    }

    async recoverEmergencyProjects() {
      const storage = localStorageOrNull();
      if (!storage) return 0;
      let keys = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key && key.startsWith(RECOVERY_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return 0;
      }
      let recoveredCount = 0;
      for (const key of keys) {
        try {
          const wrapper = JSON.parse(storage.getItem(key) || "null");
          if (!wrapper || !wrapper.project || typeof wrapper.savedAt !== "string") {
            storage.removeItem(key);
            continue;
          }
          const recovery = root.PaperTools.normalizeProject(wrapper.project);
          const stored = await this.getProject(recovery.id);
          if (stored && Date.parse(stored.updatedAt) > Date.parse(wrapper.savedAt)) {
            this.clearEmergencyProject(recovery.id);
            continue;
          }
          if (stored) {
            const storedAssets = new Map(stored.assets.map((asset) => [asset.id, asset]));
            recovery.assets = recovery.assets.map((asset) => {
              const prior = storedAssets.get(asset.id);
              return Object.assign({}, asset, { data: prior && prior.data ? prior.data : asset.data || null });
            });
            recovery.history = stored.history;
          }
          await this.saveProject(recovery);
          recoveredCount += 1;
        } catch (_error) {
          // Keep a valid-looking entry for a later attempt; discard malformed JSON only.
          try {
            JSON.parse(storage.getItem(key) || "null");
          } catch (_parseError) {
            storage.removeItem(key);
          }
        }
      }
      return recoveredCount;
    }

    async listProjects() {
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(PROJECTS_STORE, "readonly");
        const items = await requestAsPromise(tx.objectStore(PROJECTS_STORE).getAll());
        return items.map(root.PaperTools.normalizeProject).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      let items = this._readFallbackProjects();
      if (this.mode === "localstorage" && this.memoryProjects.size) {
        const merged = new Map(items.map((project) => [project.id, project]));
        this.memoryProjects.forEach((project, id) => merged.set(id, project));
        items = Array.from(merged.values());
      }
      return items.map(root.PaperTools.normalizeProject).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async getProject(id) {
      if (!id) return null;
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(PROJECTS_STORE, "readonly");
        const item = await requestAsPromise(tx.objectStore(PROJECTS_STORE).get(id));
        return item ? root.PaperTools.normalizeProject(item) : null;
      }
      if (this.mode === "localstorage" && this.memoryProjects.has(id)) {
        return root.PaperTools.normalizeProject(this.memoryProjects.get(id));
      }
      const item = this._readFallbackProjects().find((project) => project.id === id);
      return item ? root.PaperTools.normalizeProject(item) : null;
    }

    async saveProject(project, options) {
      const shouldClearRecovery = !options || options.clearRecovery !== false;
      const normalized = root.PaperTools.normalizeProject(project);
      normalized.updatedAt = root.PaperTools.nowIso();
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(PROJECTS_STORE, "readwrite");
        tx.objectStore(PROJECTS_STORE).put(normalized);
        await transactionDone(tx);
        if (shouldClearRecovery) this.clearEmergencyProject(normalized.id);
        return normalized;
      }
      if (this.mode === "localstorage") {
        const projects = this._readFallbackProjects().filter((item) => item.id !== normalized.id);
        const portable = root.PaperTools.deepClone(normalized);
        portable.assets = portable.assets.map((asset) => Object.assign({}, asset, { data: null }));
        projects.push(portable);
        root.localStorage.setItem(FALLBACK_PROJECTS_KEY, JSON.stringify(projects));
        this.memoryProjects.set(normalized.id, root.PaperTools.deepClone(normalized));
      } else {
        this.memoryProjects.set(normalized.id, root.PaperTools.deepClone(normalized));
      }
      if (shouldClearRecovery) this.clearEmergencyProject(normalized.id);
      return normalized;
    }

    async replaceProjectIfUnchanged(project, expectedUpdatedAt) {
      const normalized = root.PaperTools.normalizeProject(project);
      const expectedVersion = expectedUpdatedAt == null ? null : String(expectedUpdatedAt);
      normalized.updatedAt = root.PaperTools.nowIso();

      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(PROJECTS_STORE, "readwrite");
        const completion = transactionDone(tx);
        const store = tx.objectStore(PROJECTS_STORE);
        let current;
        try {
          current = await requestAsPromise(store.get(normalized.id));
        } catch (error) {
          try {
            tx.abort();
          } catch (_abortError) {
            // The transaction may already have aborted after the failed request.
          }
          await completion.catch(() => {});
          throw error;
        }
        if (projectVersion(current) !== expectedVersion) {
          tx.abort();
          await completion.catch(() => {});
          throw projectChangedError();
        }
        store.put(normalized);
        await completion;
        this.clearEmergencyProject(normalized.id);
        return normalized;
      }

      const current = await this.getProject(normalized.id);
      if (projectVersion(current) !== expectedVersion) throw projectChangedError();
      return this.saveProject(normalized);
    }

    async deleteProject(id) {
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(PROJECTS_STORE, "readwrite");
        tx.objectStore(PROJECTS_STORE).delete(id);
        await transactionDone(tx);
        this.clearEmergencyProject(id);
        return;
      }
      if (this.mode === "localstorage") {
        const projects = this._readFallbackProjects().filter((item) => item.id !== id);
        root.localStorage.setItem(FALLBACK_PROJECTS_KEY, JSON.stringify(projects));
        this.memoryProjects.delete(id);
      } else {
        this.memoryProjects.delete(id);
      }
      this.clearEmergencyProject(id);
    }

    async duplicateProject(id) {
      const source = await this.getProject(id);
      if (!source) throw new Error("複製元のプロジェクトが見つかりません．");
      const clone = root.PaperTools.normalizeProject(source);
      clone.id = root.PaperTools.makeId("project");
      clone.name = `${source.name}（コピー）`;
      clone.createdAt = root.PaperTools.nowIso();
      clone.updatedAt = clone.createdAt;
      clone.history = [];
      clone.assets = source.assets.map((asset) => Object.assign({}, asset, { id: root.PaperTools.makeId("asset") }));
      return this.saveProject(clone);
    }

    async getSettings() {
      const defaults = Object.assign({}, root.PaperTools.DEFAULT_SETTINGS || {});
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SETTINGS_STORE, "readonly");
        const item = await requestAsPromise(tx.objectStore(SETTINGS_STORE).get("global"));
        return Object.assign(defaults, item && item.value ? item.value : {});
      }
      if (this.mode === "localstorage") {
        try {
          return Object.assign(defaults, JSON.parse(root.localStorage.getItem(FALLBACK_SETTINGS_KEY) || "{}"));
        } catch (_error) {
          return defaults;
        }
      }
      return Object.assign(defaults, this.memorySettings);
    }

    async saveSettings(settings) {
      const value = Object.assign({}, root.PaperTools.DEFAULT_SETTINGS || {}, settings || {});
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SETTINGS_STORE, "readwrite");
        tx.objectStore(SETTINGS_STORE).put({ key: "global", value });
        await transactionDone(tx);
      } else if (this.mode === "localstorage") {
        root.localStorage.setItem(FALLBACK_SETTINGS_KEY, JSON.stringify(value));
      } else {
        this.memorySettings = value;
      }
      return value;
    }

    async getSyncMeta(ownerId, localProjectId) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      const local = normalizeSyncId(localProjectId, "ローカルproject ID", false);
      const key = makeSyncMetaKey(owner, local);
      let item = null;
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_META_STORE, "readonly");
        item = await requestAsPromise(tx.objectStore(SYNC_META_STORE).get(key));
      } else {
        const records = this._mergedFallbackSyncRecords("meta");
        item = records.find((record) => record.key === key) || null;
      }
      if (!item) return null;
      try {
        return normalizeSyncMeta(owner, local, item, null);
      } catch (_error) {
        this.warning = "不正な同期メタデータを読み飛ばしました．";
        return null;
      }
    }

    async listSyncMeta(ownerId) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      let items = [];
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_META_STORE, "readonly");
        items = await requestAsPromise(
          tx.objectStore(SYNC_META_STORE).index("ownerId").getAll(owner),
        );
      } else {
        items = this._mergedFallbackSyncRecords("meta").filter((item) => item.ownerId === owner);
      }
      return items
        .map((item) => {
          try {
            return normalizeSyncMeta(owner, item.localProjectId, item, null);
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (b.lastSyncedAt || b.updatedAt).localeCompare(a.lastSyncedAt || a.updatedAt));
    }

    async saveSyncMeta(ownerId, localProjectId, metadata) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      const local = normalizeSyncId(localProjectId, "ローカルproject ID", false);
      const existing = await this.getSyncMeta(owner, local);
      const normalized = normalizeSyncMeta(owner, local, metadata || Object.create(null), existing);
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_META_STORE, "readwrite");
        tx.objectStore(SYNC_META_STORE).put(normalized);
        await transactionDone(tx);
        return normalizeSyncMeta(owner, local, normalized, null);
      }
      this.memorySyncMeta.set(normalized.key, normalized);
      this.deletedSyncMetaKeys.delete(normalized.key);
      if (this.mode === "localstorage") {
        const records = this._mergedFallbackSyncRecords("meta")
          .filter((item) => item.key !== normalized.key);
        records.push(normalized);
        this._persistFallbackSyncRecords("meta", records);
      }
      return normalizeSyncMeta(owner, local, normalized, null);
    }

    async deleteSyncMeta(ownerId, localProjectId) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      const local = normalizeSyncId(localProjectId, "ローカルproject ID", false);
      const key = makeSyncMetaKey(owner, local);
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_META_STORE, "readwrite");
        tx.objectStore(SYNC_META_STORE).delete(key);
        await transactionDone(tx);
        return;
      }
      this.memorySyncMeta.delete(key);
      if (this.mode === "localstorage") {
        const records = this._mergedFallbackSyncRecords("meta")
          .filter((item) => item.key !== key);
        if (!this._persistFallbackSyncRecords("meta", records)) {
          this.deletedSyncMetaKeys.add(key);
        }
      }
    }

    async enqueueSyncOperation(ownerId, operation) {
      const normalized = normalizeSyncOutboxItem(ownerId, operation);
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_OUTBOX_STORE, "readwrite");
        tx.objectStore(SYNC_OUTBOX_STORE).add(normalized);
        await transactionDone(tx);
        return normalizeSyncOutboxItem(normalized.ownerId, normalized);
      }
      const records = this._mergedFallbackSyncRecords("outbox");
      if (records.some((item) => item.key === normalized.key)) {
        throw new Error("同じoutbox IDが既に存在します．");
      }
      this.memorySyncOutbox.set(normalized.key, normalized);
      this.deletedSyncOutboxKeys.delete(normalized.key);
      if (this.mode === "localstorage") {
        records.push(normalized);
        this._persistFallbackSyncRecords("outbox", records);
      }
      return normalizeSyncOutboxItem(normalized.ownerId, normalized);
    }

    async listSyncOutbox(ownerId) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      let items = [];
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_OUTBOX_STORE, "readonly");
        items = await requestAsPromise(
          tx.objectStore(SYNC_OUTBOX_STORE).index("ownerId").getAll(owner),
        );
      } else {
        items = this._mergedFallbackSyncRecords("outbox").filter((item) => item.ownerId === owner);
      }
      return items
        .map((item) => {
          try {
            return normalizeSyncOutboxItem(owner, item);
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    async deleteSyncOutboxItem(ownerId, outboxId) {
      const owner = normalizeSyncId(ownerId, "ユーザID", false);
      const id = normalizeSyncId(outboxId, "outbox ID", false);
      const key = makeSyncOutboxKey(owner, id);
      if (this.mode === "indexeddb") {
        const tx = this.db.transaction(SYNC_OUTBOX_STORE, "readwrite");
        tx.objectStore(SYNC_OUTBOX_STORE).delete(key);
        await transactionDone(tx);
        return;
      }
      this.memorySyncOutbox.delete(key);
      if (this.mode === "localstorage") {
        const records = this._mergedFallbackSyncRecords("outbox")
          .filter((item) => item.key !== key);
        if (!this._persistFallbackSyncRecords("outbox", records)) {
          this.deletedSyncOutboxKeys.add(key);
        }
      }
    }

    _mergedFallbackSyncRecords(kind) {
      const memory = kind === "meta" ? this.memorySyncMeta : this.memorySyncOutbox;
      const deleted = kind === "meta" ? this.deletedSyncMetaKeys : this.deletedSyncOutboxKeys;
      const merged = new Map();
      if (this.mode === "localstorage") {
        this._readFallbackSyncRecords(kind).forEach((item) => merged.set(item.key, item));
      }
      memory.forEach((item, key) => merged.set(key, item));
      deleted.forEach((key) => merged.delete(key));
      return Array.from(merged.values());
    }

    _readFallbackSyncRecords(kind) {
      const storage = localStorageOrNull();
      if (!storage) return [];
      const storageKey = kind === "meta" ? FALLBACK_SYNC_META_KEY : FALLBACK_SYNC_OUTBOX_KEY;
      let raw = "";
      try {
        raw = storage.getItem(storageKey) || "[]";
      } catch (_error) {
        this.warning = "同期情報の簡易保存領域を読み取れませんでした．";
        return [];
      }
      if (raw.length > MAX_SYNC_FALLBACK_BYTES) {
        this.warning = "同期情報の簡易保存領域が上限を超えたため読み飛ばしました．";
        return [];
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        this.warning = "破損した同期情報を読み飛ばしました．";
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, MAX_SYNC_RECORDS).map((item) => {
        try {
          if (!item || typeof item !== "object") return null;
          if (kind === "meta") {
            return normalizeSyncMeta(item.ownerId, item.localProjectId, item, null);
          }
          if (!hasOwn(item, "id")) return null;
          return normalizeSyncOutboxItem(item.ownerId, item);
        } catch (_error) {
          return null;
        }
      }).filter(Boolean);
    }

    _persistFallbackSyncRecords(kind, records) {
      if (!Array.isArray(records) || records.length > MAX_SYNC_RECORDS) {
        throw new Error("同期情報の保存件数が上限を超えています．");
      }
      const storage = localStorageOrNull();
      if (!storage) return false;
      const storageKey = kind === "meta" ? FALLBACK_SYNC_META_KEY : FALLBACK_SYNC_OUTBOX_KEY;
      const serialized = JSON.stringify(records);
      if (serialized.length > MAX_SYNC_FALLBACK_BYTES) {
        throw new Error("同期情報の簡易保存サイズが上限を超えています．");
      }
      try {
        storage.setItem(storageKey, serialized);
        return true;
      } catch (_error) {
        this.warning = "同期情報はこのタブ内だけに退避されました．端末保存した原稿には影響しません．";
        return false;
      }
    }

    _readFallbackProjects() {
      if (this.mode === "memory") return Array.from(this.memoryProjects.values());
      try {
        const parsed = JSON.parse(root.localStorage.getItem(FALLBACK_PROJECTS_KEY) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        return [];
      }
    }
  }

  return {
    Repository,
    DB_NAME,
    DB_VERSION,
    RECOVERY_PREFIX,
    SYNC_META_STORE,
    SYNC_OUTBOX_STORE,
    SYNC_STATUSES,
    OUTBOX_OPERATIONS,
    MAX_SYNCED_ASSET_IDS,
    MAX_OUTBOX_ITEM_BYTES,
    makeSyncMetaKey,
    makeSyncOutboxKey,
    normalizeSyncMeta,
    normalizeSyncOutboxItem,
  };
});
