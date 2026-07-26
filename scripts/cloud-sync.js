(function (root, factory) {
  "use strict";

  var namespace = root.PaperTools || (root.PaperTools = {});
  var api = factory(root, namespace);
  root.PaperTools = Object.assign(namespace, api);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, PaperTools) {
  "use strict";

  var CLOUD_SCHEMA = Object.freeze({
    projectsTable: "projects",
    attachmentsBucket: "paper-assets",
    projectColumns: "cloud_id,project_id,payload,revision,created_at,updated_at",
    ownerColumn: "owner_id",
    projectIdColumn: "project_id",
    cloudIdColumn: "cloud_id",
    projectColumn: "payload",
    revisionColumn: "revision",
    saveProjectRpc: "save_project",
    deleteProjectRpc: "delete_project",
  });

  var CLOUD_LIMITS = Object.freeze({
    maxProjectBytes: 4 * 1024 * 1024,
    maxAttachmentBytes: 20 * 1024 * 1024,
    absoluteMaxAttachmentBytes: 50 * 1024 * 1024,
    maxProjectsPerRequest: 200,
    maxEmailChars: 254,
    maxPasswordChars: 1024,
    maxIdChars: 120,
  });

  var FORBIDDEN_CONFIG_KEYS = Object.freeze([
    "serviceRoleKey",
    "service_role_key",
    "secretKey",
    "secret_key",
    "jwtSecret",
    "jwt_secret",
    "privateKey",
    "private_key",
  ]);

  var FORBIDDEN_DATA_KEYS = Object.freeze({
    "__proto__": true,
    prototype: true,
    constructor: true,
    user_id: true,
    owner_id: true,
    auth_user_id: true,
    created_by: true,
    access_token: true,
    refresh_token: true,
    service_role_key: true,
  });

  var ATTACHMENT_TYPES = Object.freeze({
    png: Object.freeze({ contentType: "image/png", aliases: ["image/png"] }),
    jpg: Object.freeze({ contentType: "image/jpeg", aliases: ["image/jpeg"] }),
    jpeg: Object.freeze({ contentType: "image/jpeg", aliases: ["image/jpeg"] }),
    pdf: Object.freeze({ contentType: "application/pdf", aliases: ["application/pdf"] }),
    csv: Object.freeze({
      contentType: "text/csv",
      aliases: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"],
    }),
    json: Object.freeze({ contentType: "application/json", aliases: ["application/json", "text/json", "text/plain"] }),
    txt: Object.freeze({ contentType: "text/plain", aliases: ["text/plain"] }),
    yaml: Object.freeze({
      contentType: "application/yaml",
      aliases: ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"],
    }),
    yml: Object.freeze({
      contentType: "application/yaml",
      aliases: ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml", "text/plain"],
    }),
  });

  function CloudSyncError(code, message, details) {
    this.name = "CloudSyncError";
    this.code = code || "cloud-error";
    this.message = cleanText(message || "クラウド同期でエラーが発生しました。", 500);
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, CloudSyncError);
  }
  CloudSyncError.prototype = Object.create(Error.prototype);
  CloudSyncError.prototype.constructor = CloudSyncError;

  function CloudConflictError(message, details) {
    CloudSyncError.call(
      this,
      "revision-conflict",
      message || "別の端末でプロジェクトが更新されています。最新状態を取得してから再度保存してください。",
      details,
    );
    this.name = "CloudConflictError";
  }
  CloudConflictError.prototype = Object.create(CloudSyncError.prototype);
  CloudConflictError.prototype.constructor = CloudConflictError;

  function cleanText(value, maximum) {
    var limit = Number.isFinite(maximum) ? maximum : 10000;
    return String(value === undefined || value === null ? "" : value)
      .replace(/\u0000/g, "")
      .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .slice(0, limit);
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function clampInteger(value, minimum, maximum, fallback) {
    var parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) parsed = fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function utf8ByteLength(value) {
    var source = String(value);
    if (typeof root.TextEncoder === "function") return new root.TextEncoder().encode(source).byteLength;
    return unescape(encodeURIComponent(source)).length;
  }

  function publicHostname(hostname) {
    var name = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!name || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return false;
    if (name === "::1" || name === "[::1]") return false;
    if (name.indexOf(":") !== -1) return false;
    var ipv4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return true;
    var octets = ipv4.slice(1).map(Number);
    if (octets.some(function (item) { return item < 0 || item > 255; })) return false;
    if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) return false;
    if (octets[0] === 169 && octets[1] === 254) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    return true;
  }

  function normalizePublicUrl(value, label) {
    var source = cleanText(value, 2048).trim();
    var parsed;
    try {
      parsed = new root.URL(source);
    } catch (_error) {
      throw new CloudSyncError("invalid-config", (label || "URL") + "が正しくありません。");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new CloudSyncError("invalid-config", (label || "URL") + "には公開HTTPS URLだけを指定できます。");
    }
    if (!publicHostname(parsed.hostname)) {
      throw new CloudSyncError("invalid-config", (label || "URL") + "にローカルまたはプライベートなホストは指定できません。");
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  }

  function base64UrlDecode(value) {
    var source = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    while (source.length % 4) source += "=";
    if (typeof root.atob === "function") return root.atob(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source, "base64").toString("utf8");
    throw new CloudSyncError("invalid-config", "anonキーを検証できません。");
  }

  function jwtClaims(value) {
    var parts = String(value || "").split(".");
    if (parts.length !== 3) return null;
    try {
      return JSON.parse(base64UrlDecode(parts[1]));
    } catch (_error) {
      return null;
    }
  }

  function validatePublicKey(value) {
    var key = cleanText(value, 4096).trim();
    if (!key || /\s/.test(key)) {
      throw new CloudSyncError("invalid-config", "Supabaseのpublishableキーまたはanonキーを指定してください。");
    }
    if (/service[_-]?role|sb_secret_|secret[_-]?key|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY/i.test(key)) {
      throw new CloudSyncError("unsafe-key", "管理者用または秘密のキーはブラウザーへ設定できません。");
    }
    if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
      return { key: key, kind: "publishable" };
    }
    var claims = jwtClaims(key);
    if (claims) {
      if (cleanText(claims.role, 80) !== "anon") {
        throw new CloudSyncError("unsafe-key", "ブラウザーではroleがanonの公開キーだけを利用できます。");
      }
      return { key: key, kind: "anon" };
    }
    throw new CloudSyncError("unsafe-key", "publishableキーまたはrole=anonの旧形式キーだけを利用できます。");
  }

  function safeResourceName(value, fallback, kind) {
    var source = cleanText(value || fallback, 80).trim();
    var pattern = kind === "bucket" ? /^[a-z0-9][a-z0-9_-]{0,62}$/ : /^[a-z][a-z0-9_]{0,62}$/;
    if (!pattern.test(source)) {
      throw new CloudSyncError("invalid-config", (kind === "bucket" ? "Storageバケット名" : "テーブル名") + "が安全ではありません。");
    }
    return source;
  }

  function readConfiguredKey(config) {
    var candidates = [config.publishableKey, config.anonKey, config.key]
      .filter(function (item) { return item !== undefined && item !== null && String(item).trim(); })
      .map(String);
    var distinct = candidates.filter(function (item, index) { return candidates.indexOf(item) === index; });
    if (distinct.length > 1) {
      throw new CloudSyncError("invalid-config", "複数の異なるSupabaseキーが指定されています。");
    }
    return distinct[0] || "";
  }

  function normalizeCloudConfig(input) {
    var config = isPlainObject(input) ? input : {};
    FORBIDDEN_CONFIG_KEYS.forEach(function (key) {
      if (config[key] !== undefined && config[key] !== null && String(config[key]).trim()) {
        throw new CloudSyncError("unsafe-key", "秘密鍵または管理者用キーは設定できません。");
      }
    });
    var configuredKey = readConfiguredKey(config);
    var prevalidatedKey = configuredKey ? validatePublicKey(configuredKey) : null;
    if (config.enabled !== true) {
      return Object.freeze({ enabled: false });
    }
    var validatedKey = prevalidatedKey || validatePublicKey(configuredKey);
    var allowedRedirectOrigins = Array.isArray(config.allowedRedirectOrigins)
      ? config.allowedRedirectOrigins.slice(0, 10).map(function (item) {
          return normalizePublicUrl(item, "リダイレクト許可URL");
        }).map(function (item) {
          return new root.URL(item).origin;
        }).filter(function (item, index, values) {
          return values.indexOf(item) === index;
        })
      : [];
    var projectsTable = safeResourceName(config.projectsTable, CLOUD_SCHEMA.projectsTable, "table");
    var attachmentsBucket = safeResourceName(
      config.attachmentsBucket,
      CLOUD_SCHEMA.attachmentsBucket,
      "bucket",
    );
    if (projectsTable !== CLOUD_SCHEMA.projectsTable || attachmentsBucket !== CLOUD_SCHEMA.attachmentsBucket) {
      throw new CloudSyncError(
        "invalid-config",
        "クラウド同期のテーブル名と非公開Storageバケット名は変更できません。",
      );
    }
    return Object.freeze({
      enabled: true,
      url: normalizePublicUrl(config.url || config.supabaseUrl, "Supabase URL"),
      key: validatedKey.key,
      keyKind: validatedKey.kind,
      projectsTable: projectsTable,
      attachmentsBucket: attachmentsBucket,
      maxProjectBytes: clampInteger(
        config.maxProjectBytes,
        64 * 1024,
        CLOUD_LIMITS.maxProjectBytes,
        CLOUD_LIMITS.maxProjectBytes,
      ),
      maxAttachmentBytes: clampInteger(
        config.maxAttachmentBytes,
        1024,
        CLOUD_LIMITS.absoluteMaxAttachmentBytes,
        CLOUD_LIMITS.maxAttachmentBytes,
      ),
      allowedRedirectOrigins: Object.freeze(allowedRedirectOrigins),
      sessionStorage: config.sessionStorage || null,
    });
  }

  function memorySessionStorage() {
    var values = Object.create(null);
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function (key, value) {
        values[key] = String(value);
      },
      removeItem: function (key) {
        delete values[key];
      },
    };
  }

  function createSessionStorageAdapter(candidate) {
    var storage = candidate;
    if (!storage) {
      try {
        storage = root.sessionStorage || null;
      } catch (_error) {
        storage = null;
      }
    }
    var browserLocalStorage = null;
    try {
      browserLocalStorage = root.localStorage || null;
    } catch (_error) {
      browserLocalStorage = null;
    }
    if (browserLocalStorage && storage === browserLocalStorage) {
      throw new CloudSyncError("unsafe-auth-storage", "認証セッションをlocalStorageへ保存することはできません。");
    }
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      storage = memorySessionStorage();
    }
    var prefix = "paper_tools_auth_session_";
    return Object.freeze({
      getItem: function (key) {
        try {
          return storage.getItem(prefix + cleanText(key, 300));
        } catch (_error) {
          return null;
        }
      },
      setItem: function (key, value) {
        try {
          storage.setItem(prefix + cleanText(key, 300), String(value));
        } catch (_error) {
          throw new CloudSyncError("auth-storage-failed", "認証セッションをsessionStorageへ保存できません。");
        }
      },
      removeItem: function (key) {
        try {
          storage.removeItem(prefix + cleanText(key, 300));
        } catch (_error) {
          // Signing out must remain best-effort if the tab storage became unavailable.
        }
      },
    });
  }

  function safeJsonValue(value, depth, state) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
    if (typeof value === "bigint") return String(value);
    if (depth > 12) return null;
    if (typeof root.Blob === "function" && value instanceof root.Blob) return null;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return null;
    if (state.seen.indexOf(value) !== -1) return null;
    state.seen.push(value);
    var result;
    if (Array.isArray(value)) {
      result = value.slice(0, 5000).map(function (item) {
        var safe = safeJsonValue(item, depth + 1, state);
        return safe === undefined ? null : safe;
      });
    } else if (isPlainObject(value)) {
      result = Object.create(null);
      Object.keys(value).slice(0, 500).forEach(function (key) {
        var normalizedKey = cleanText(key, 200);
        if (!normalizedKey || FORBIDDEN_DATA_KEYS[normalizedKey.toLowerCase()]) return;
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.get || descriptor.set) return;
        var safe = safeJsonValue(descriptor.value, depth + 1, state);
        if (safe !== undefined) Object.defineProperty(result, normalizedKey, {
          value: safe,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
    } else {
      result = null;
    }
    state.seen.pop();
    return result;
  }

  function sanitizeProjectForCloud(project, options) {
    if (!isPlainObject(project)) {
      throw new CloudSyncError("invalid-project", "保存するプロジェクトが正しくありません。");
    }
    var normalized;
    if (typeof PaperTools.normalizeProject === "function") {
      normalized = PaperTools.normalizeProject(project);
    } else {
      normalized = project;
    }
    var safe = safeJsonValue(normalized, 0, { seen: [] });
    if (!safe || typeof safe !== "object") {
      throw new CloudSyncError("invalid-project", "プロジェクトを安全な形式へ変換できません。");
    }
    if (Array.isArray(safe.assets)) {
      safe.assets = safe.assets.map(function (asset) {
        if (!asset || typeof asset !== "object") return null;
        asset.data = null;
        delete asset.blob;
        delete asset.bytes;
        delete asset.content;
        return asset;
      }).filter(Boolean);
    }
    var serialized;
    try {
      serialized = JSON.stringify(safe);
    } catch (_error) {
      throw new CloudSyncError("invalid-project", "プロジェクトをJSONへ変換できません。");
    }
    var configuredLimit = options && options.maxProjectBytes;
    var limit = clampInteger(
      configuredLimit,
      64 * 1024,
      CLOUD_LIMITS.maxProjectBytes,
      CLOUD_LIMITS.maxProjectBytes,
    );
    if (utf8ByteLength(serialized) > limit) {
      throw new CloudSyncError("project-too-large", "プロジェクト本体がクラウド保存の上限を超えています。");
    }
    return JSON.parse(serialized);
  }

  function canonicalJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (!value || typeof value !== "object") return value;
    var result = Object.create(null);
    Object.keys(value).sort().forEach(function (key) {
      result[key] = canonicalJsonValue(value[key]);
    });
    return result;
  }

  function canonicalProjectJson(project, options) {
    return JSON.stringify(canonicalJsonValue(sanitizeProjectForCloud(project, options)));
  }

  async function fingerprintProjectForCloud(project, options) {
    if (!root.crypto || !root.crypto.subtle || typeof root.crypto.subtle.digest !== "function") {
      throw new CloudSyncError("crypto-unavailable", "このブラウザーでは安全な内容指紋を計算できません。");
    }
    var bytes = new root.TextEncoder().encode(canonicalProjectJson(project, options));
    var digest = new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest).map(function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");
  }

  function safeId(value, label) {
    var source = cleanText(value, CLOUD_LIMITS.maxIdChars).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(source)) {
      throw new CloudSyncError("invalid-id", (label || "ID") + "が安全ではありません。");
    }
    return source;
  }

  function safeRevision(value, required) {
    if ((value === undefined || value === null) && !required) return null;
    var revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new CloudSyncError("invalid-revision", "revisionには1以上の整数を指定してください。");
    }
    return revision;
  }

  function safeUuid(value, label) {
    var source = cleanText(value, 80).trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source)) {
      throw new CloudSyncError("invalid-uuid", (label || "UUID") + "が正しくありません。");
    }
    return source;
  }

  function assetUuid(value) {
    var source = cleanText(value, CLOUD_LIMITS.maxIdChars).trim();
    var match = source.match(/^asset_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    if (!match) {
      throw new CloudSyncError(
        "legacy-attachment-id",
        "この添付は旧形式のIDです。クラウド同期するにはファイルを削除して再添付してください。",
      );
    }
    return match[1].toLowerCase();
  }

  function safeIso(value) {
    var source = cleanText(value, 80);
    return Number.isFinite(Date.parse(source)) ? new Date(source).toISOString() : null;
  }

  function sanitizedUser(user) {
    if (!user || typeof user !== "object") return null;
    var id = cleanText(user.id, 120);
    if (!id) return null;
    return Object.freeze({
      id: id,
      email: cleanText(user.email, CLOUD_LIMITS.maxEmailChars),
      emailConfirmedAt: safeIso(user.email_confirmed_at),
      lastSignInAt: safeIso(user.last_sign_in_at),
    });
  }

  function sanitizedSession(session) {
    var user = sanitizedUser(session && session.user);
    if (!user) return Object.freeze({ signedIn: false, user: null, expiresAt: null });
    var expiresAt = Number(session.expires_at);
    return Object.freeze({
      signedIn: true,
      user: user,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    });
  }

  function safeEmail(value) {
    var email = cleanText(value, CLOUD_LIMITS.maxEmailChars).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CloudSyncError("invalid-email", "メールアドレスを確認してください。");
    }
    return email;
  }

  function safePassword(value) {
    var password = String(value === undefined || value === null ? "" : value);
    if (password.length < 8 || password.length > CLOUD_LIMITS.maxPasswordChars || /\u0000/.test(password)) {
      throw new CloudSyncError("invalid-password", "パスワードは8文字以上で指定してください。");
    }
    return password;
  }

  function safeRedirectUrl(value, config) {
    if (!value) return undefined;
    var url = normalizePublicUrl(value, "認証後URL");
    var parsed = new root.URL(url);
    var allowed = config.allowedRedirectOrigins || [];
    if (allowed.length && allowed.indexOf(parsed.origin) === -1) {
      throw new CloudSyncError("invalid-redirect", "認証後URLのオリジンは許可されていません。");
    }
    if (!allowed.length && root.location && root.location.protocol === "https:" && parsed.origin !== root.location.origin) {
      throw new CloudSyncError("invalid-redirect", "認証後URLはこのアプリと同じオリジンにしてください。");
    }
    return url;
  }

  function remoteError(operation, error) {
    var code = cleanText(error && error.code, 80);
    if (code === "23505") return new CloudConflictError("同じIDのプロジェクトが既に存在します。");
    if (code === "401" || code === "403" || Number(error && error.status) === 401 || Number(error && error.status) === 403) {
      return new CloudSyncError("access-denied", "認証またはRLSポリシーにより操作できません。");
    }
    return new CloudSyncError(
      "remote-error",
      cleanText(operation, 80) + "に失敗しました。" + (error && error.message ? " " + cleanText(error.message, 300) : ""),
      { operation: cleanText(operation, 80), remoteCode: code || null },
    );
  }

  function unwrap(response, operation) {
    if (!response || typeof response !== "object") {
      throw new CloudSyncError("invalid-response", cleanText(operation, 80) + "の応答が正しくありません。");
    }
    if (response.error) throw remoteError(operation, response.error);
    return response.data;
  }

  function authResult(response, operation) {
    var data = unwrap(response, operation) || {};
    var session = data.session || null;
    var user = data.user || (session && session.user) || null;
    return Object.freeze({
      user: sanitizedUser(user),
      session: sanitizedSession(session),
    });
  }

  function extensionOf(filename) {
    var match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    return match ? match[1] : "";
  }

  function validateAttachmentDescriptor(asset, maximum) {
    if (!isPlainObject(asset)) {
      throw new CloudSyncError("invalid-attachment", "添付ファイルの情報が正しくありません。");
    }
    var id = safeId(asset.id, "添付ID");
    var name = cleanText(asset.name, 220).trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.indexOf("..") !== -1 ||
      /[\/\\\u0000-\u001f\u007f<>:"|?*]/.test(name)
    ) {
      throw new CloudSyncError("unsafe-attachment-name", "添付ファイル名が安全ではありません。");
    }
    var extension = extensionOf(name);
    var typeInfo = ATTACHMENT_TYPES[extension];
    if (!typeInfo) {
      if (extension === "svg") {
        throw new CloudSyncError("unsafe-attachment-type", "SVGは実行可能な内容を含められるためクラウド添付では利用できません。");
      }
      throw new CloudSyncError("unsupported-attachment", "この添付形式はクラウド同期できません。");
    }
    var data = asset.data !== undefined ? asset.data : asset.blob;
    var size = 0;
    if (typeof root.Blob === "function" && data instanceof root.Blob) {
      size = data.size;
    } else if (data instanceof ArrayBuffer) {
      size = data.byteLength;
    } else if (ArrayBuffer.isView(data)) {
      size = data.byteLength;
    } else {
      throw new CloudSyncError("invalid-binary", "添付本体にはBlob、ArrayBuffer、またはTypedArrayだけを使用できます。");
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > maximum) {
      throw new CloudSyncError("attachment-too-large", "添付ファイルが空か、クラウド保存の上限を超えています。");
    }
    if (Number(asset.size) > 0 && Number(asset.size) !== size) {
      throw new CloudSyncError("attachment-size-mismatch", "添付ファイルの登録サイズと実サイズが一致しません。");
    }
    var declared = cleanText(asset.type, 160).trim().toLowerCase();
    if (declared && declared !== "application/octet-stream" && typeInfo.aliases.indexOf(declared) === -1) {
      throw new CloudSyncError("attachment-type-mismatch", "拡張子とMIMEタイプが一致しません。");
    }
    return {
      id: id,
      name: name,
      extension: extension,
      contentType: typeInfo.contentType,
      data: data,
      size: size,
    };
  }

  async function bytesOf(data) {
    if (typeof root.Blob === "function" && data instanceof root.Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  function startsWithBytes(bytes, expected) {
    if (bytes.length < expected.length) return false;
    return expected.every(function (value, index) { return bytes[index] === value; });
  }

  async function inspectAttachment(descriptor) {
    var bytes = await bytesOf(descriptor.data);
    var extension = descriptor.extension;
    if (extension === "png" && !startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      throw new CloudSyncError("invalid-binary-signature", "PNGファイルの内容を確認できません。");
    }
    if ((extension === "jpg" || extension === "jpeg") && !startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
      throw new CloudSyncError("invalid-binary-signature", "JPEGファイルの内容を確認できません。");
    }
    if (extension === "pdf" && !startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      throw new CloudSyncError("invalid-binary-signature", "PDFファイルの内容を確認できません。");
    }
    if (["csv", "json", "txt", "yaml", "yml"].indexOf(extension) !== -1) {
      if (bytes.indexOf(0) !== -1) {
        throw new CloudSyncError("invalid-text-file", "テキスト添付にバイナリデータが含まれています。");
      }
      if (extension === "json") {
        try {
          JSON.parse(new root.TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
        } catch (_error) {
          throw new CloudSyncError("invalid-json-attachment", "JSON添付の内容が正しくありません。");
        }
      }
    }
    return bytes;
  }

  async function attachmentDataMatches(left, right) {
    var leftBytes = await bytesOf(left);
    var rightBytes = await bytesOf(right);
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    var difference = 0;
    for (var index = 0; index < leftBytes.byteLength; index += 1) {
      difference |= leftBytes[index] ^ rightBytes[index];
    }
    return difference === 0;
  }

  function storagePath(userId, projectId, descriptor) {
    return [
      safeUuid(userId, "認証ユーザーUUID"),
      safeUuid(projectId, "クラウドプロジェクトUUID"),
      assetUuid(descriptor.id),
      "payload." + descriptor.extension,
    ].join("/");
  }

  function remoteProject(row, options) {
    if (!row || typeof row !== "object") {
      throw new CloudSyncError("invalid-response", "クラウド上のプロジェクトが正しくありません。");
    }
    var id = safeId(row[CLOUD_SCHEMA.projectIdColumn], "プロジェクトID");
    var cloudId = safeUuid(row[CLOUD_SCHEMA.cloudIdColumn], "クラウドプロジェクトUUID");
    var project = sanitizeProjectForCloud(row[CLOUD_SCHEMA.projectColumn], options);
    if (safeId(project.id, "プロジェクトID") !== id) {
      throw new CloudSyncError("invalid-response", "プロジェクトIDがクラウド行と一致しません。");
    }
    return Object.freeze({
      id: id,
      cloudId: cloudId,
      revision: safeRevision(row[CLOUD_SCHEMA.revisionColumn], true),
      project: project,
      createdAt: safeIso(row.created_at),
      updatedAt: safeIso(row.updated_at),
    });
  }

  function singleRpcResult(data, operation) {
    var row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      throw new CloudSyncError("invalid-response", operation + "の応答が正しくありません。");
    }
    return row;
  }

  function CloudSyncClient(config) {
    this.config = normalizeCloudConfig(config);
    this.client = null;
    this.cachedSession = null;
    this.disposed = false;
    if (!this.config.enabled) return;
    if (root.location && root.location.protocol && root.location.protocol !== "https:") {
      throw new CloudSyncError(
        "insecure-origin",
        "クラウド同期はHTTPSで公開されたアプリからのみ利用できます。file://版は端末内保存として利用してください。",
      );
    }
    if (!root.supabase || typeof root.supabase.createClient !== "function") {
      throw new CloudSyncError(
        "sdk-unavailable",
        "Supabase SDKが読み込まれていないため、クラウド同期を開始できません。",
      );
    }
    try {
      this.client = root.supabase.createClient(this.config.url, this.config.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: createSessionStorageAdapter(this.config.sessionStorage),
        },
      });
    } catch (_error) {
      throw new CloudSyncError("initialization-failed", "クラウド同期を初期化できません。");
    }
    if (!this.client || !this.client.auth || typeof this.client.from !== "function") {
      throw new CloudSyncError("invalid-sdk", "Supabase SDKの応答が正しくありません。");
    }
  }

  CloudSyncClient.prototype.getStatus = function () {
    return Object.freeze({
      enabled: Boolean(this.config.enabled && !this.disposed),
      ready: Boolean(this.client && !this.disposed),
      url: this.config.url || null,
      keyKind: this.config.keyKind || null,
      projectsTable: this.config.projectsTable || CLOUD_SCHEMA.projectsTable,
      attachmentsBucket: this.config.attachmentsBucket || CLOUD_SCHEMA.attachmentsBucket,
      requiresRls: true,
    });
  };

  CloudSyncClient.prototype._requireEnabled = function () {
    if (this.disposed || !this.config.enabled || !this.client) {
      throw new CloudSyncError("cloud-disabled", "クラウド同期は無効です。端末内保存はそのまま利用できます。");
    }
  };

  CloudSyncClient.prototype._rememberAuth = function (response, operation) {
    var result = authResult(response, operation);
    this.cachedSession = result.session.signedIn
      ? { user: result.user, expires_at: result.session.expiresAt }
      : null;
    return result;
  };

  CloudSyncClient.prototype.getSession = async function () {
    this._requireEnabled();
    var response = await this.client.auth.getSession();
    var data = unwrap(response, "セッション確認") || {};
    var session = data.session || null;
    this.cachedSession = session;
    return sanitizedSession(session);
  };

  CloudSyncClient.prototype.subscribeAuth = function (listener) {
    this._requireEnabled();
    if (typeof listener !== "function") {
      throw new CloudSyncError("invalid-listener", "認証状態の通知先が正しくありません。");
    }
    var self = this;
    var response = this.client.auth.onAuthStateChange(function (event, session) {
      self.cachedSession = session || null;
      listener(Object.freeze({
        event: cleanText(event, 80),
        session: sanitizedSession(session),
      }));
    });
    var subscription = response && response.data && response.data.subscription;
    return function unsubscribe() {
      if (subscription && typeof subscription.unsubscribe === "function") subscription.unsubscribe();
    };
  };

  CloudSyncClient.prototype.signInWithEmailOtp = async function (email, options) {
    this._requireEnabled();
    var cfg = isPlainObject(options) ? options : {};
    var response = await this.client.auth.signInWithOtp({
      email: safeEmail(email),
      options: {
        emailRedirectTo: safeRedirectUrl(cfg.redirectTo, this.config),
        shouldCreateUser: cfg.shouldCreateUser === true,
      },
    });
    return this._rememberAuth(response, "メールリンク送信");
  };

  CloudSyncClient.prototype.signInWithPassword = async function (email, password) {
    this._requireEnabled();
    var response = await this.client.auth.signInWithPassword({
      email: safeEmail(email),
      password: safePassword(password),
    });
    return this._rememberAuth(response, "パスワード認証");
  };

  CloudSyncClient.prototype.signUp = async function (email, password, options) {
    this._requireEnabled();
    var cfg = isPlainObject(options) ? options : {};
    var authOptions = {};
    var redirect = safeRedirectUrl(cfg.redirectTo, this.config);
    if (redirect) authOptions.emailRedirectTo = redirect;
    var response = await this.client.auth.signUp({
      email: safeEmail(email),
      password: safePassword(password),
      options: authOptions,
    });
    return this._rememberAuth(response, "アカウント登録");
  };

  CloudSyncClient.prototype.verifyEmailOtp = async function (email, token, type) {
    this._requireEnabled();
    var safeToken = cleanText(token, 2048).trim();
    var safeType = ["email", "magiclink", "signup", "recovery"].indexOf(type) !== -1 ? type : "email";
    if (!/^[A-Za-z0-9_-]{6,2048}$/.test(safeToken)) {
      throw new CloudSyncError("invalid-otp", "確認コードが正しくありません。");
    }
    var response = await this.client.auth.verifyOtp({
      email: safeEmail(email),
      token: safeToken,
      type: safeType,
    });
    return this._rememberAuth(response, "確認コード認証");
  };

  CloudSyncClient.prototype.signOut = async function () {
    this._requireEnabled();
    unwrap(await this.client.auth.signOut({ scope: "local" }), "ログアウト");
    this.cachedSession = null;
    return sanitizedSession(null);
  };

  CloudSyncClient.prototype._requireSession = async function () {
    this._requireEnabled();
    var session = this.cachedSession;
    if (!session || !session.user || !session.user.id) {
      var response = await this.client.auth.getSession();
      var data = unwrap(response, "セッション確認") || {};
      session = data.session || null;
      this.cachedSession = session;
    }
    var safe = sanitizedSession(session);
    if (!safe.signedIn) {
      throw new CloudSyncError("not-authenticated", "クラウド操作にはログインが必要です。");
    }
    return safe;
  };

  CloudSyncClient.prototype.listProjects = async function (options) {
    await this._requireSession();
    var limit = clampInteger(
      options && options.limit,
      1,
      CLOUD_LIMITS.maxProjectsPerRequest,
      CLOUD_LIMITS.maxProjectsPerRequest,
    );
    var query = this.client
      .from(this.config.projectsTable)
      .select(CLOUD_SCHEMA.projectColumns)
      .order("updated_at", { ascending: false })
      .limit(limit);
    var rows = unwrap(await query, "プロジェクト一覧取得") || [];
    if (!Array.isArray(rows)) throw new CloudSyncError("invalid-response", "プロジェクト一覧の応答が正しくありません。");
    var sanitizeOptions = { maxProjectBytes: this.config.maxProjectBytes };
    return rows.map(function (row) { return remoteProject(row, sanitizeOptions); });
  };

  CloudSyncClient.prototype.getProject = async function (id) {
    await this._requireSession();
    var safeProjectId = safeId(id, "プロジェクトID");
    var query = this.client
      .from(this.config.projectsTable)
      .select(CLOUD_SCHEMA.projectColumns)
      .eq(CLOUD_SCHEMA.projectIdColumn, safeProjectId)
      .maybeSingle();
    var row = unwrap(await query, "プロジェクト取得");
    return row ? remoteProject(row, { maxProjectBytes: this.config.maxProjectBytes }) : null;
  };

  CloudSyncClient.prototype.createProject = async function (project) {
    return this._saveProject(project, 0);
  };

  CloudSyncClient.prototype.updateProject = async function (project, expectedRevision) {
    return this._saveProject(project, safeRevision(expectedRevision, true));
  };

  CloudSyncClient.prototype._saveProject = async function (project, expectedRevision) {
    await this._requireSession();
    var safeProject = sanitizeProjectForCloud(project, { maxProjectBytes: this.config.maxProjectBytes });
    var id = safeId(safeProject.id, "プロジェクトID");
    var data = unwrap(
      await this.client.rpc(CLOUD_SCHEMA.saveProjectRpc, {
        p_project_id: id,
        expected_revision: expectedRevision,
        new_payload: safeProject,
      }),
      expectedRevision === 0 ? "プロジェクト作成" : "プロジェクト更新",
    );
    var result = singleRpcResult(data, "プロジェクト保存");
    var status = cleanText(result.status, 40);
    if (status === "conflict") {
      var latest = await this.getProject(id);
      throw new CloudConflictError(undefined, { latest: latest });
    }
    if (status === "not_found") {
      throw new CloudSyncError("project-not-found", "クラウド上のプロジェクトが見つかりません。");
    }
    if (status !== "saved") {
      throw new CloudSyncError("invalid-response", "プロジェクト保存の状態が正しくありません。");
    }
    return Object.freeze({
      id: id,
      cloudId: safeUuid(result.cloud_id, "クラウドプロジェクトUUID"),
      revision: safeRevision(result.revision, true),
      project: safeProject,
      createdAt: null,
      updatedAt: safeIso(result.updated_at),
    });
  };

  CloudSyncClient.prototype.saveProject = function (project, options) {
    var expected = options && options.expectedRevision;
    return expected === undefined || expected === null
      ? this.createProject(project)
      : this.updateProject(project, expected);
  };

  CloudSyncClient.prototype.deleteProject = async function (id, expectedRevision) {
    await this._requireSession();
    var safeProjectId = safeId(id, "プロジェクトID");
    var revision = safeRevision(expectedRevision, true);
    var latest = await this.getProject(safeProjectId);
    if (!latest) throw new CloudSyncError("project-not-found", "クラウド上のプロジェクトが見つかりません。");
    if (latest.revision !== revision) {
      throw new CloudConflictError("削除前に別の端末でプロジェクトが更新されています。", { latest: latest });
    }
    if (Array.isArray(latest.project.assets) && latest.project.assets.length) {
      throw new CloudSyncError(
        "attachments-block-delete",
        "添付のあるクラウドプロジェクトは安全に自動削除できません。ZIPバックアップ後、管理者へ削除を依頼してください。",
      );
    }

    var data = unwrap(
      await this.client.rpc(CLOUD_SCHEMA.deleteProjectRpc, {
        p_project_id: safeProjectId,
        expected_revision: revision,
      }),
      "プロジェクト削除",
    );
    var result = singleRpcResult(data, "プロジェクト削除");
    var status = cleanText(result.status, 40);
    if (status === "conflict") {
      var conflicted = await this.getProject(safeProjectId);
      throw new CloudConflictError("削除前に別の端末でプロジェクトが更新されています。", { latest: conflicted });
    }
    if (status === "not_found") {
      throw new CloudSyncError("project-not-found", "クラウド上のプロジェクトが見つかりません。");
    }
    if (status === "attachments_present") {
      throw new CloudSyncError(
        "attachments-block-delete",
        "添付のあるクラウドプロジェクトは安全に自動削除できません。ZIPバックアップ後、管理者へ削除を依頼してください。",
      );
    }
    if (status !== "deleted") {
      throw new CloudSyncError("invalid-response", "プロジェクト削除の状態が正しくありません。");
    }
    return Object.freeze({
      id: safeProjectId,
      cloudId: safeUuid(result.cloud_id, "クラウドプロジェクトUUID"),
      revision: safeRevision(result.revision, true),
      deleted: true,
    });
  };

  CloudSyncClient.prototype.uploadAttachment = async function (cloudId, asset, options) {
    var session = await this._requireSession();
    if (options && options.upsert === true) {
      throw new CloudSyncError(
        "unsafe-attachment-overwrite",
        "既存のクラウド添付は上書きできません。更新する場合はファイルを再添付して新しいIDを作成してください。",
      );
    }
    var descriptor = validateAttachmentDescriptor(asset, this.config.maxAttachmentBytes);
    await inspectAttachment(descriptor);
    var safeCloudId = safeUuid(cloudId, "クラウドプロジェクトUUID");
    var path = storagePath(session.user.id, safeCloudId, descriptor);
    var recoveredExisting = false;
    try {
      var response = await this.client.storage
        .from(this.config.attachmentsBucket)
        .upload(path, descriptor.data, {
          contentType: descriptor.contentType,
          cacheControl: "0",
          upsert: false,
        });
      unwrap(response, "添付アップロード");
    } catch (uploadError) {
      // The object may have been committed even if the browser lost the
      // response. Because v1 objects are immutable, an exact byte match is a
      // safe idempotent success; a different object at the same path is not.
      var existing = null;
      try {
        existing = await this.downloadAttachment(safeCloudId, asset);
      } catch (_downloadError) {
        throw uploadError;
      }
      if (!(await attachmentDataMatches(descriptor.data, existing.data))) {
        throw new CloudSyncError(
          "attachment-content-conflict",
          "同じ添付IDのクラウドファイルが別内容です。上書きせず、端末側でファイルを削除して再添付してください。",
        );
      }
      recoveredExisting = true;
    }
    return Object.freeze({
      cloudId: safeCloudId,
      assetId: descriptor.id,
      name: descriptor.name,
      path: path,
      size: descriptor.size,
      type: descriptor.contentType,
      recoveredExisting: recoveredExisting,
    });
  };

  CloudSyncClient.prototype.downloadAttachment = async function (cloudId, asset) {
    var session = await this._requireSession();
    var descriptor = validateAttachmentDescriptor(
      Object.assign({}, asset, { data: new Uint8Array([1]), size: 1 }),
      this.config.maxAttachmentBytes,
    );
    var safeCloudId = safeUuid(cloudId, "クラウドプロジェクトUUID");
    var path = storagePath(session.user.id, safeCloudId, descriptor);
    var data = unwrap(
      await this.client.storage.from(this.config.attachmentsBucket).download(path),
      "添付ダウンロード",
    );
    var size = typeof root.Blob === "function" && data instanceof root.Blob
      ? data.size
      : data instanceof ArrayBuffer
        ? data.byteLength
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : -1;
    if (size < 1 || size > this.config.maxAttachmentBytes) {
      throw new CloudSyncError("invalid-download", "ダウンロードした添付のサイズが正しくありません。");
    }
    if (typeof root.Blob === "function" && data instanceof root.Blob && data.type) {
      var receivedType = cleanText(data.type, 160).toLowerCase().split(";")[0].trim();
      if (receivedType && receivedType !== descriptor.contentType) {
        throw new CloudSyncError("invalid-download", "ダウンロードした添付のMIMEタイプが拡張子と一致しません。");
      }
    }
    var verifiedBytes = await inspectAttachment(Object.assign({}, descriptor, { data: data, size: size }));
    var verifiedData = typeof root.Blob === "function"
      ? new root.Blob([verifiedBytes], { type: descriptor.contentType })
      : verifiedBytes;
    return Object.freeze({
      cloudId: safeCloudId,
      assetId: descriptor.id,
      name: descriptor.name,
      path: path,
      size: size,
      type: descriptor.contentType,
      data: verifiedData,
    });
  };

  CloudSyncClient.prototype.dispose = function () {
    this.cachedSession = null;
    this.client = null;
    this.disposed = true;
  };

  function createCloudSync(config) {
    return new CloudSyncClient(config);
  }

  return {
    CLOUD_SCHEMA: CLOUD_SCHEMA,
    CLOUD_LIMITS: CLOUD_LIMITS,
    CloudSyncError: CloudSyncError,
    CloudConflictError: CloudConflictError,
    CloudSyncClient: CloudSyncClient,
    normalizeCloudConfig: normalizeCloudConfig,
    createSessionStorageAdapter: createSessionStorageAdapter,
    validatePublicSupabaseKey: validatePublicKey,
    sanitizeProjectForCloud: sanitizeProjectForCloud,
    canonicalProjectJson: canonicalProjectJson,
    fingerprintProjectForCloud: fingerprintProjectForCloud,
    createCloudSync: createCloudSync,
    initCloudSync: createCloudSync,
  };
});
