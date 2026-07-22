(function (root, factory) {
  "use strict";

  var api = factory();
  var namespace = root.PaperTools || (root.PaperTools = {});

  namespace.templates = api.templates;
  namespace.TEMPLATES = api.TEMPLATES;
  namespace.templateMap = api.templateMap;
  namespace.getTemplate = api.getTemplate;
  namespace.listTemplates = api.listTemplates;
  namespace.registerCustomTemplate = api.registerCustomTemplate;
  namespace.unregisterCustomTemplate = api.unregisterCustomTemplate;
  namespace.listCustomTemplates = api.listCustomTemplates;
  namespace.BUILT_IN_TEMPLATE_IDS = api.BUILT_IN_TEMPLATE_IDS;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function section(id, titleJa, titleEn) {
    return {
      id: id,
      title: titleJa,
      titleJa: titleJa,
      titleEn: titleEn,
    };
  }

  var templates = [
    {
      id: "generic-ja",
      name: "日本語標準論文",
      language: "ja",
      languages: ["ja"],
      type: "research-paper",
      documentTypes: ["research-paper", "journal-paper", "thesis-draft"],
      description: "日本語の一般的な研究論文を構成する標準テンプレートです。",
      requiredInputs: ["title", "objective", "method"],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("related-work", "関連研究", "Related Work"),
        section("method", "提案手法", "Method"),
        section("experiments", "実験", "Experiments"),
        section("results-discussion", "結果と考察", "Results and Discussion"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "generic-en",
      name: "English Research Paper",
      language: "en",
      languages: ["en"],
      type: "research-paper",
      documentTypes: ["research-paper", "journal-paper", "thesis-draft"],
      description: "A clear, general-purpose structure for an English research paper.",
      requiredInputs: ["title", "objective", "method"],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("related-work", "関連研究", "Related Work"),
        section("method", "手法", "Method"),
        section("experiments", "実験", "Experiments"),
        section("results", "結果", "Results"),
        section("discussion", "考察", "Discussion"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "engineering-two-column",
      name: "工学系2段組論文",
      language: "ja",
      languages: ["ja", "en"],
      type: "engineering-paper",
      layout: "two-column",
      documentTypes: ["conference-paper", "engineering-paper"],
      description: "工学系の短い会議論文を想定した汎用2段組構成です。",
      requiredInputs: ["title", "objective", "method"],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("related-work", "関連研究", "Related Work"),
        section("method", "提案手法", "Proposed Method"),
        section("experiments", "実験", "Experiments"),
        section("results", "結果", "Results"),
        section("discussion", "考察", "Discussion"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "robotics-experiment",
      name: "ロボティクス実験論文",
      language: "ja",
      languages: ["ja", "en"],
      type: "robotics-paper",
      documentTypes: ["robotics-paper", "experiment-paper"],
      description: "ロボット設計、制御手法、実験評価を分けて記述する構成です。",
      requiredInputs: [
        "title",
        "objective",
        "systemDesign",
        "method",
        "experimentalConditions",
        "metrics",
      ],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("related-work", "関連研究", "Related Work"),
        section("system-design", "ロボット・システム設計", "Robot and System Design"),
        section("control-method", "制御手法", "Control Method"),
        section("experimental-setup", "実験条件", "Experimental Setup"),
        section("evaluation-metrics", "評価指標", "Evaluation Metrics"),
        section("results", "結果", "Results"),
        section("discussion", "考察", "Discussion"),
        section("limitations", "制約と失敗例", "Limitations"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "short-paper",
      name: "短報",
      language: "ja",
      languages: ["ja", "en"],
      type: "short-paper",
      documentTypes: ["short-paper", "technical-note"],
      description: "単一の貢献を4～6ページ程度で簡潔に報告する構成です。",
      requiredInputs: ["title", "objective", "method"],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("proposed-approach", "提案アプローチ", "Proposed Approach"),
        section("evaluation", "評価", "Evaluation"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "literature-review",
      name: "文献レビュー",
      language: "ja",
      languages: ["ja", "en"],
      type: "literature-review",
      documentTypes: ["literature-review", "survey"],
      description: "検索戦略、分類、比較、研究ギャップを追跡可能に整理する構成です。",
      requiredInputs: ["title", "objective", "references"],
      sections: [
        section("abstract", "概要", "Abstract"),
        section("introduction", "はじめに", "Introduction"),
        section("search-strategy", "検索戦略", "Search Strategy"),
        section("classification", "文献の分類", "Classification"),
        section("comparison", "比較", "Comparison"),
        section("research-gaps", "研究ギャップ", "Research Gaps"),
        section("discussion", "考察", "Discussion"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "research-proposal",
      name: "研究計画書",
      language: "ja",
      languages: ["ja", "en"],
      type: "research-proposal",
      documentTypes: ["research-proposal", "grant-draft"],
      description: "研究課題、実施計画、期待結果、リスクを整理する構成です。",
      requiredInputs: ["title", "background", "problem", "objective", "method"],
      sections: [
        section("abstract", "概要", "Executive Summary"),
        section("background", "背景", "Background"),
        section("problem", "研究課題", "Problem"),
        section("objectives", "研究目的", "Objectives"),
        section("proposed-method", "提案手法", "Proposed Method"),
        section("research-plan", "研究計画", "Research Plan"),
        section("expected-results", "期待される結果", "Expected Results"),
        section("risks", "リスク", "Risks"),
        section("schedule", "スケジュール", "Schedule"),
        section("references", "参考文献", "References"),
      ],
    },
    {
      id: "experiment-report",
      name: "実験報告書",
      language: "ja",
      languages: ["ja", "en"],
      type: "experiment-report",
      documentTypes: ["experiment-report", "laboratory-report"],
      description: "装置、条件、手順、結果、分析を再現可能に記録する構成です。",
      requiredInputs: ["title", "objective", "experimentalConditions", "method"],
      sections: [
        section("abstract", "要約", "Summary"),
        section("objective", "目的", "Objective"),
        section("equipment", "使用機器", "Equipment"),
        section("conditions", "実験条件", "Conditions"),
        section("procedure", "手順", "Procedure"),
        section("results", "結果", "Results"),
        section("analysis", "分析", "Analysis"),
        section("problems", "問題点", "Problems"),
        section("conclusion", "結論", "Conclusion"),
        section("references", "参考資料", "References"),
      ],
    },
  ];

  var templateMap = {};
  var builtInTemplateIds = templates.map(function (template) {
    return template.id;
  });
  var builtInTemplateIdSet = Object.create(null);
  builtInTemplateIds.forEach(function (id) {
    builtInTemplateIdSet[id] = true;
  });
  templates.forEach(function (template) {
    template.sectionIds = template.sections.map(function (item) {
      return item.id;
    });
    templateMap[template.id] = template;
  });

  function getTemplate(id) {
    return templateMap[id] || templateMap["generic-ja"];
  }

  function listTemplates() {
    return templates.slice();
  }

  function registerCustomTemplate(template) {
    if (!template || typeof template !== "object") {
      throw new TypeError("カスタムテンプレート定義を読み取れませんでした．");
    }
    var id = String(template.id || "").trim();
    if (!/^custom-[a-z0-9][a-z0-9_-]{0,56}$/.test(id)) {
      throw new Error("カスタムテンプレートIDが不正です．");
    }
    if (builtInTemplateIdSet[id]) {
      throw new Error("組込みテンプレートは上書きできません．");
    }
    if (!Array.isArray(template.sections) || !template.sections.length) {
      throw new Error("テンプレートにセクションがありません．");
    }
    var registered = Object.assign({}, template, {
      id: id,
      custom: true,
      isCustom: true,
      sectionIds: template.sections.map(function (item) {
        return item.id;
      }),
    });
    var existingIndex = templates.findIndex(function (item) {
      return item.id === id;
    });
    if (existingIndex >= 0) templates.splice(existingIndex, 1, registered);
    else templates.push(registered);
    templateMap[id] = registered;
    return registered;
  }

  function unregisterCustomTemplate(id) {
    if (!id || builtInTemplateIdSet[id]) return false;
    var index = templates.findIndex(function (item) {
      return item.id === id && item.isCustom;
    });
    if (index < 0) return false;
    templates.splice(index, 1);
    delete templateMap[id];
    return true;
  }

  function listCustomTemplates() {
    return templates.filter(function (template) {
      return template.isCustom;
    });
  }

  return {
    templates: templates,
    TEMPLATES: templates,
    templateMap: templateMap,
    getTemplate: getTemplate,
    listTemplates: listTemplates,
    registerCustomTemplate: registerCustomTemplate,
    unregisterCustomTemplate: unregisterCustomTemplate,
    listCustomTemplates: listCustomTemplates,
    BUILT_IN_TEMPLATE_IDS: builtInTemplateIds.slice(),
  };
});
