(function (root, factory) {
  "use strict";
  const api = factory(root);
  root.PaperTools = Object.assign(root.PaperTools || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DB_NAME = "paper_tools_static";
  const DB_VERSION = 1;
  const PROJECTS_STORE = "projects";
  const SETTINGS_STORE = "settings";
  const FALLBACK_PROJECTS_KEY = "paper_tools_projects_v1";
  const FALLBACK_SETTINGS_KEY = "paper_tools_settings_v1";
  const RECOVERY_PREFIX = "paper_tools_recovery_v1_";

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

  class Repository {
    constructor() {
      this.db = null;
      this.mode = "initializing";
      this.warning = "";
      this.memoryProjects = new Map();
      this.memorySettings = Object.assign({}, root.PaperTools.DEFAULT_SETTINGS || {});
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
          };
          this.db = await requestAsPromise(request);
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

  return { Repository, DB_NAME, DB_VERSION, RECOVERY_PREFIX };
});
