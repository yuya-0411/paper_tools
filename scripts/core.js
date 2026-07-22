(function (root, factory) {
  "use strict";
  const api = factory(root);
  root.PaperTools = Object.assign(root.PaperTools || {}, api);
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
  const MAX_BACKUP_ENTRIES = 2048;
  const DEFAULT_SETTINGS = Object.freeze({
    punctuation: "ja-comma-period",
    englishVariant: "american",
    uploadLimitMb: 10,
    historyLimit: 20,
    theme: "light",
  });

  const RESEARCH_FIELDS = [
    "simpleDescription",
    "bulletNotes",
    "achievements",
    "keyMessage",
    "objective",
    "background",
    "novelty",
    "method",
    "experiment",
    "results",
    "discussion",
    "conclusion",
    "comparison",
    "trialCount",
    "statistics",
    "limitations",
    "reproducibility",
    "problem",
    "systemDesign",
    "experimentalConditions",
    "metrics",
    "searchStrategy",
    "classification",
    "researchGaps",
    "researchPlan",
    "expectedResults",
    "schedule",
    "equipment",
    "futureWork",
    "dataAvailability",
    "ethics",
    "notes",
  ];

  const ALLOWED_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "svg",
    "pdf",
    "csv",
    "json",
    "txt",
    "yaml",
    "yml",
  ]);

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    const safePrefix = String(prefix || "id").replace(/[^a-z0-9_-]/gi, "");
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return `${safePrefix}_${root.crypto.randomUUID()}`;
    }
    return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function plainText(value, maxLength) {
    const limit = Number.isFinite(maxLength) ? maxLength : 100000;
    return String(value == null ? "" : value)
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n")
      .slice(0, limit);
  }

  function safeFilename(value, fallback) {
    let cleaned = plainText(value, 1000)
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\.\.+/g, ".")
      .replace(/^\.+|[. ]+$/g, "")
      .trim();
    cleaned = cleaned || fallback || "paper-tools-project";
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && /^\.[A-Za-z0-9]{1,16}$/.test(cleaned.slice(dot))
      ? cleaned.slice(dot)
      : "";
    let stem = extension ? cleaned.slice(0, -extension.length) : cleaned;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
    return stem.slice(0, Math.max(1, 180 - extension.length)).replace(/[. ]+$/g, "") + extension;
  }

  function extensionOf(filename) {
    const match = plainText(filename, 260).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function normalizeCitationKey(value) {
    return plainText(value, 120)
      .trim()
      .replace(/[^A-Za-z0-9_.:-]+/g, "-")
      .replace(/^[.:-]+|[.:-]+$/g, "");
  }

  function normalizeReferenceDate(value) {
    const source = plainText(value, 10).trim();
    if (/^\d{4}$/.test(source)) return source;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(source)) return source;
    const match = source.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? source
      : "";
  }

  function validateUpload(file, settings) {
    const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    if (!file || typeof file.name !== "string") {
      return { ok: false, message: "ファイルを読み取れませんでした．" };
    }
    const ext = extensionOf(file.name);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { ok: false, message: `.${ext || "不明"} は追加できません．対応形式を確認してください．` };
    }
    if (file.name.includes("/") || file.name.includes("\\") || file.name.includes("..")) {
      return { ok: false, message: "安全でないファイル名です．ファイル名を変更してください．" };
    }
    const limit = Math.max(1, Number(cfg.uploadLimitMb) || 10) * 1024 * 1024;
    if (Number(file.size) > limit) {
      return { ok: false, message: `ファイルサイズが上限 ${cfg.uploadLimitMb} MB を超えています．` };
    }
    return { ok: true, extension: ext };
  }

  function deepClone(value) {
    if (typeof root.structuredClone === "function") {
      try {
        return root.structuredClone(value);
      } catch (_error) {
        // JSON fallback below is sufficient for snapshots, which do not include Blob data.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function getTemplate(templateId) {
    const templates = (root.PaperTools && root.PaperTools.TEMPLATES) || [];
    return templates.find((item) => item.id === templateId) || templates[0] || {
      id: "generic-ja",
      language: "ja",
      type: "research-paper",
      sections: [
        { id: "abstract", title: "概要" },
        { id: "introduction", title: "はじめに" },
        { id: "method", title: "方法" },
        { id: "results", title: "結果" },
        { id: "discussion", title: "考察" },
        { id: "conclusion", title: "結論" },
      ],
    };
  }

  function normalizeTemplateDefinition(value) {
    if (!value || typeof value !== "object") return null;
    const id = plainText(value.id, 100).trim();
    if (!/^custom-[a-z0-9][a-z0-9_-]{0,56}$/.test(id)) return null;
    const seen = new Set();
    const sections = (Array.isArray(value.sections) ? value.sections : []).slice(0, 60).map((item, index) => {
      const rawId = plainText(item && item.id, 100)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || `section-${index + 1}`;
      let sectionId = rawId;
      let suffix = 2;
      while (seen.has(sectionId)) {
        sectionId = `${rawId}-${suffix}`;
        suffix += 1;
      }
      seen.add(sectionId);
      const title = plainText(item && (item.title || item.titleJa || item.titleEn), 300).trim() || `Section ${index + 1}`;
      return {
        id: sectionId,
        title,
        titleJa: plainText(item && (item.titleJa || item.title), 300).trim() || title,
        titleEn: plainText(item && (item.titleEn || item.title), 300).trim() || title,
        guidance: plainText(item && item.guidance, 2000).trim(),
      };
    });
    if (!sections.length) return null;
    const allowedRequired = new Set(["title", "references", ...RESEARCH_FIELDS]);
    const requiredInputs = (Array.isArray(value.requiredInputs) ? value.requiredInputs : ["title"])
      .map((item) => plainText(item, 80).trim())
      .filter((item, index, items) => allowedRequired.has(item) && items.indexOf(item) === index)
      .slice(0, 30);
    return {
      customTemplateVersion: 1,
      id,
      name: plainText(value.name || "登録テンプレート", 200).trim() || "登録テンプレート",
      language: value.language === "en" ? "en" : "ja",
      languages: Array.isArray(value.languages) && value.languages.includes("en") && value.languages.includes("ja")
        ? ["ja", "en"]
        : [value.language === "en" ? "en" : "ja"],
      type: plainText(value.type || "research-paper", 80).trim() || "research-paper",
      documentTypes: (Array.isArray(value.documentTypes) ? value.documentTypes : [value.type || "research-paper"])
        .map((item) => plainText(item, 80).trim())
        .filter(Boolean)
        .slice(0, 12),
      description: plainText(value.description || "アップロードしたファイルから自動解釈したテンプレートです．", 1000).trim(),
      layout: value.layout === "two-column" ? "two-column" : "single-column",
      requiredInputs: requiredInputs.length ? requiredInputs : ["title"],
      sections,
      sectionIds: sections.map((section) => section.id),
      custom: true,
      isCustom: true,
      source: {
        kind: plainText(value.source && value.source.kind, 80).trim(),
        filename: plainText(value.source && value.source.filename, 260).trim(),
        format: plainText(value.source && value.source.format, 40).trim(),
        importedAt: plainText(value.source && value.source.importedAt, 40).trim(),
        fingerprint: plainText(value.source && value.source.fingerprint, 80).trim(),
        byteLength: Math.max(0, Math.min(524288, Number(value.source && value.source.byteLength) || 0)),
      },
      interpretation: {
        confidence: Math.max(0, Math.min(1, Number(value.interpretation && value.interpretation.confidence) || 0)),
        warnings: (Array.isArray(value.interpretation && value.interpretation.warnings) ? value.interpretation.warnings : [])
          .map((item) => plainText(item, 500).trim())
          .filter(Boolean)
          .slice(0, 20),
      },
    };
  }

  function createProject(templateId, seed) {
    const template = getTemplate(templateId || "generic-ja");
    const createdAt = nowIso();
    const input = seed || {};
    return normalizeProject({
      schemaVersion: SCHEMA_VERSION,
      id: makeId("project"),
      name: input.name || "無題のプロジェクト",
      title: input.title || "",
      documentType: input.documentType || template.type || "research-paper",
      language: input.language || template.language || "ja",
      englishVariant: input.englishVariant === "british" ? "british" : "american",
      field: input.field || "",
      pageTarget: input.pageTarget || "",
      targetAudience: input.targetAudience || "",
      submissionNotes: input.submissionNotes || "",
      templateId: template.id,
      templateDefinition: template.isCustom ? normalizeTemplateDefinition(template) : null,
      punctuation: input.punctuation || "ja-comma-period",
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      authors: [],
      research: {},
      keywords: input.keywords || [],
      instructions: { global: "", sections: {}, presets: [] },
      references: [],
      assets: [],
      manuscript: {
        generatedAt: null,
        sections: template.sections.map((section) => ({
          id: section.id,
          title: section.title,
          content: "",
          updatedAt: createdAt,
        })),
        advice: [],
      },
      history: [],
      ui: { activeSectionId: template.sections[0] ? template.sections[0].id : "abstract", wizardStep: 1 },
    });
  }

  function normalizeProject(project) {
    const source = project || {};
    const embeddedTemplate = normalizeTemplateDefinition(source.templateDefinition);
    const template = embeddedTemplate && embeddedTemplate.id === source.templateId
      ? embeddedTemplate
      : getTemplate(source.templateId || "generic-ja");
    const normalized = {};
    normalized.schemaVersion = SCHEMA_VERSION;
    normalized.id = plainText(source.id || makeId("project"), 120);
    normalized.name = plainText(source.name || source.title || "無題のプロジェクト", 200);
    normalized.title = plainText(source.title, 500);
    normalized.documentType = plainText(source.documentType || template.type || "research-paper", 80);
    normalized.language = source.language === "en" ? "en" : "ja";
    normalized.englishVariant = source.englishVariant === "british" ? "british" : "american";
    normalized.field = plainText(source.field, 300);
    normalized.pageTarget = plainText(source.pageTarget, 40);
    normalized.targetAudience = plainText(source.targetAudience, 1000);
    normalized.submissionNotes = plainText(source.submissionNotes, 5000);
    normalized.templateId = plainText(source.templateId || template.id, 100);
    normalized.templateDefinition = template.isCustom ? normalizeTemplateDefinition(template) : null;
    normalized.punctuation = source.punctuation === "ja-standard" ? "ja-standard" : "ja-comma-period";
    normalized.status = ["draft", "generated", "completed", "failed"].includes(source.status)
      ? source.status
      : "draft";
    normalized.typstSource = plainText(source.typstSource, 2000000);
    normalized.createdAt = source.createdAt || nowIso();
    normalized.updatedAt = source.updatedAt || normalized.createdAt;
    normalized.authors = Array.isArray(source.authors)
      ? source.authors.map((author) => ({
          id: plainText(author.id || makeId("author"), 120),
          name: plainText(author.name, 200),
          affiliation: plainText(author.affiliation, 300),
          email: plainText(author.email, 320),
          orcid: plainText(author.orcid, 40),
          corresponding: Boolean(author.corresponding),
        }))
      : [];
    normalized.research = {};
    for (const key of RESEARCH_FIELDS) {
      normalized.research[key] = plainText(source.research && source.research[key], 50000);
    }
    if (!normalized.research.experimentalConditions && normalized.research.experiment) {
      normalized.research.experimentalConditions = normalized.research.experiment;
    }
    normalized.keywords = Array.isArray(source.keywords)
      ? source.keywords.map((item) => plainText(item, 100)).filter(Boolean).slice(0, 30)
      : plainText(source.keywords, 1000)
          .split(/[,，\n]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 30);
    const instructions = source.instructions || {};
    normalized.instructions = {
      global: plainText(instructions.global, 20000),
      sections: {},
      presets: Array.isArray(instructions.presets)
        ? instructions.presets.map((item) => plainText(item, 80)).filter(Boolean).slice(0, 20)
        : [],
    };
    if (instructions.sections && typeof instructions.sections === "object") {
      for (const [key, value] of Object.entries(instructions.sections)) {
        const safeKey = plainText(key, 100);
        if (!safeKey || ["__proto__", "prototype", "constructor"].includes(safeKey)) continue;
        normalized.instructions.sections[safeKey] = plainText(value, 10000);
      }
    }
    normalized.references = Array.isArray(source.references)
      ? source.references.map((reference) => ({
          id: plainText(reference.id || makeId("ref"), 120),
          key: normalizeCitationKey(reference.key),
          type: plainText(reference.type || "article", 40),
          title: plainText(reference.title, 1000),
          authors: Array.isArray(reference.authors)
            ? reference.authors.map((author) => plainText(author && author.name ? author.name : author, 300)).filter(Boolean).slice(0, 100)
            : plainText(reference.authors, 1000),
          year: plainText(reference.year, 10),
          venue: plainText(reference.venue, 1000),
          doi: plainText(reference.doi, 300),
          url: plainText(reference.url, 2000),
          note: plainText(reference.note, 3000),
        }))
      : [];
    normalized.assets = Array.isArray(source.assets)
      ? source.assets.map((asset) => ({
          id: plainText(asset.id || makeId("asset"), 120),
          name: safeFilename(asset.name, "asset"),
          displayName: plainText(asset.displayName || safeFilename(asset.name, "asset"), 300),
          type: plainText(asset.type || "application/octet-stream", 160),
          size: Number(asset.size) || 0,
          lastModified: Number(asset.lastModified) || Date.now(),
          caption: plainText(asset.caption, 2000),
          role: plainText(asset.role || "other", 40),
          target: plainText(asset.target, 100),
          source: plainText(asset.source, 2000),
          origin: ["self", "cited", "unknown"].includes(asset.origin) ? asset.origin : "self",
          data: asset.data || asset.blob || null,
        }))
      : [];
    const sourceManuscript = source.manuscript || {};
    const existingSections = Array.isArray(sourceManuscript.sections) ? sourceManuscript.sections : [];
    const sectionDefinitions = template.sections.slice();
    const knownSectionIds = new Set(sectionDefinitions.map((section) => section.id));
    existingSections.slice(0, 100).forEach((section, index) => {
      const id = plainText(section && section.id, 100) || `section-${index + 1}`;
      if (["__proto__", "prototype", "constructor"].includes(id) || knownSectionIds.has(id)) return;
      knownSectionIds.add(id);
      sectionDefinitions.push({ id, title: plainText(section.title || id, 300) });
    });
    normalized.manuscript = {
      generatedAt: sourceManuscript.generatedAt || null,
      sections: sectionDefinitions.map((section) => {
        const existing = existingSections.find((item) => item.id === section.id) || {};
        const defaultTitle = normalized.language === "en"
          ? section.titleEn || section.title || section.id
          : section.titleJa || section.title || section.id;
        const existingTitle = plainText(existing.title, 300);
        const knownDefaultTitles = [section.title, section.titleJa, section.titleEn]
          .map((value) => plainText(value, 300))
          .filter(Boolean);
        const usesKnownDefault = existingTitle && knownDefaultTitles.includes(existingTitle);
        return {
          id: section.id,
          title: plainText(usesKnownDefault ? defaultTitle : existingTitle || defaultTitle, 300),
          content: plainText(existing.content, 100000),
          updatedAt: existing.updatedAt || normalized.updatedAt,
        };
      }),
      advice: Array.isArray(sourceManuscript.advice)
        ? sourceManuscript.advice.map((item) => ({
            id: plainText(item.id || makeId("advice"), 160),
            severity: ["required", "recommended", "optional"].includes(item.severity)
              ? item.severity
              : "recommended",
            title: plainText(item.title, 500),
            reason: plainText(item.reason, 3000),
            target: plainText(item.target, 120),
            action: plainText(item.action, 3000),
            resolved: Boolean(item.resolved),
          }))
        : [],
    };
    normalized.history = Array.isArray(source.history) ? source.history.slice(-100) : [];
    const sourceUi = source.ui && typeof source.ui === "object" ? source.ui : {};
    normalized.ui = {
      activeSectionId: plainText(
        sourceUi.activeSectionId || (template.sections[0] && template.sections[0].id),
        100,
      ),
      typstSnapshotTaken: Boolean(sourceUi.typstSnapshotTaken),
      wizardStep: Math.min(5, Math.max(1, Number.parseInt(sourceUi.wizardStep, 10) || 1)),
      researchMode: sourceUi.researchMode === "detail" ? "detail" : "simple",
    };
    return normalized;
  }

  function snapshotProject(project, action, target, settings) {
    const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const copy = normalizeProject(project);
    copy.assets = copy.assets.map((asset) => Object.assign({}, asset, { data: null }));
    copy.history = [];
    const snapshot = {
      id: makeId("snapshot"),
      createdAt: nowIso(),
      action: plainText(action || "manual-save", 120),
      target: plainText(target || "project", 120),
      provider: "rule-based",
      instruction: plainText(copy.instructions.global, 1000),
      project: copy,
    };
    const history = Array.isArray(project.history) ? project.history.slice() : [];
    history.push(snapshot);
    return history.slice(-Math.max(1, Number(cfg.historyLimit) || 20));
  }

  function projectCompleteness(project) {
    const value = normalizeProject(project);
    const checks = [
      Boolean(value.title.trim()),
      Boolean(value.authors.some((author) => author.name.trim())),
      Boolean(value.research.objective.trim()),
      Boolean(value.research.background.trim()),
      Boolean(value.research.method.trim()),
      Boolean(value.research.results.trim()),
      Boolean(value.research.discussion.trim()),
      Boolean(value.research.conclusion.trim()),
      Boolean(value.keywords.length),
      Boolean(value.references.length),
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const context = this;
      root.clearTimeout(timer);
      timer = root.setTimeout(() => fn.apply(context, args), wait);
    };
  }

  function formatDate(value, language) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat(language === "en" ? "en-US" : "ja-JP", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  return {
    SCHEMA_VERSION,
    MAX_BACKUP_BYTES,
    MAX_BACKUP_ENTRIES,
    DEFAULT_SETTINGS,
    RESEARCH_FIELDS,
    ALLOWED_EXTENSIONS,
    nowIso,
    makeId,
    plainText,
    safeFilename,
    extensionOf,
    normalizeCitationKey,
    normalizeReferenceDate,
    normalizeTemplateDefinition,
    validateUpload,
    deepClone,
    getTemplate,
    createProject,
    normalizeProject,
    snapshotProject,
    projectCompleteness,
    debounce,
    formatDate,
  };
});
