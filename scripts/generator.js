(function (root, factory) {
  "use strict";

  var namespace = root.PaperTools || (root.PaperTools = {});
  var api = factory(namespace);

  namespace.generateManuscript = api.generateManuscript;
  namespace.analyzeProject = api.analyzeProject;
  namespace.regenerateSection = api.regenerateSection;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (namespace) {
  "use strict";

  var FIELD_ALIASES = {
    title: ["paperTitle", "title"],
    summary: ["summary", "abstract"],
    simpleDescription: ["simpleDescription", "simple_description", "notes"],
    bulletNotes: ["bulletNotes", "bullet_notes"],
    achievements: ["achievements", "achievement"],
    keyMessage: ["keyMessage", "key_message"],
    background: ["background", "researchBackground"],
    problem: ["problem", "researchProblem"],
    objective: ["objective", "researchObjective", "purpose"],
    novelty: ["novelty", "contribution", "contributions"],
    method: ["method", "proposedMethod", "approach", "procedure"],
    systemDesign: ["systemDesign", "system_design", "architecture"],
    experimentalConditions: [
      "experimentalConditions",
      "experimental_conditions",
      "conditions",
      "experimentalSetup",
      "experiment",
    ],
    metrics: ["metrics", "evaluationMetrics", "evaluation_metrics"],
    statistics: ["statistics", "statisticalAnalysis", "statistical_analysis", "dispersion"],
    results: ["results", "measuredResults", "observations"],
    discussion: ["discussion", "analysis", "interpretation"],
    comparison: ["comparison", "baseline", "baselines"],
    trialCount: ["trialCount", "trial_count", "trials", "numberOfTrials"],
    limitations: ["limitations", "risks", "problems", "failureConditions"],
    reproducibility: ["reproducibility", "reproduction", "replication"],
    conclusion: ["conclusion", "conclusions"],
    futureWork: ["futureWork", "future_work"],
    searchStrategy: ["searchStrategy", "search_strategy"],
    classification: ["classification", "classificationScheme"],
    researchGaps: ["researchGaps", "research_gaps", "gaps"],
    researchPlan: ["researchPlan", "research_plan", "workPlan"],
    expectedResults: ["expectedResults", "expected_results", "hypothesis", "hypotheses"],
    schedule: ["schedule", "timeline", "milestones"],
    equipment: ["equipment", "apparatus", "instruments"],
  };

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeText(value) {
    if (value === null || value === undefined) {
      return "";
    }
    if (Array.isArray(value)) {
      return value
        .map(normalizeText)
        .filter(Boolean)
        .join("\n");
    }
    if (typeof value !== "string" && typeof value !== "number") {
      return "";
    }
    return String(value)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .split("\n")
      .map(function (line) {
        return line.replace(/[ \t]+$/g, "");
      })
      .join("\n")
      .trim();
  }

  function sourcesFor(project) {
    var source = isObject(project) ? project : {};
    var candidates = [
      source.paperSpec,
      source.paper_spec,
      source.spec,
      source.paper,
      source.inputs,
      source.data,
      source.research,
      source,
    ];
    return candidates.filter(isObject);
  }

  function readValue(project, names) {
    var sources = sourcesFor(project);
    var index;
    var nameIndex;
    for (index = 0; index < sources.length; index += 1) {
      for (nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        if (hasOwn(sources[index], names[nameIndex])) {
          var value = normalizeText(sources[index][names[nameIndex]]);
          if (value) {
            return value;
          }
        }
      }
    }
    return "";
  }

  function readArray(project, names) {
    var sources = sourcesFor(project);
    var index;
    var nameIndex;
    for (index = 0; index < sources.length; index += 1) {
      for (nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        var value = sources[index][names[nameIndex]];
        if (Array.isArray(value)) {
          return value.slice();
        }
      }
    }
    return [];
  }

  function readObject(project, names) {
    var sources = sourcesFor(project);
    var index;
    var nameIndex;
    for (index = 0; index < sources.length; index += 1) {
      for (nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        var value = sources[index][names[nameIndex]];
        if (isObject(value)) {
          return value;
        }
      }
    }
    return {};
  }

  function readField(project, name) {
    return readValue(project, FIELD_ALIASES[name] || [name]);
  }

  function normalizeReferences(project) {
    return readArray(project, ["references", "bibliography"]).map(function (item, index) {
      var reference = isObject(item) ? item : {};
      return {
        key:
          typeof namespace.normalizeCitationKey === "function"
            ? namespace.normalizeCitationKey(reference.key || reference.citationKey || reference.citation_key)
            : normalizeText(reference.key || reference.citationKey || reference.citation_key),
        title: normalizeText(reference.title),
        authors: Array.isArray(reference.authors)
          ? reference.authors.map(normalizeText).filter(Boolean)
          : typeof reference.authors === "string"
            ? reference.authors.split(/\s*;\s*|\s+and\s+/i).map(normalizeText).filter(Boolean)
            : [],
        year: normalizeText(reference.year),
        venue: normalizeText(reference.venue || reference.journal || reference.publisher),
        doi: normalizeText(reference.doi),
        url: normalizeText(reference.url),
        sourceIndex: index,
      };
    });
  }

  function normalizeAssets(project) {
    return readArray(project, ["assets", "figures", "files"]).map(function (item, index) {
      var asset = isObject(item) ? item : { name: item };
      return {
        name: normalizeText(asset.displayName || asset.name || asset.fileName || asset.filename),
        kind: normalizeText(asset.kind || asset.type),
        description: normalizeText(asset.description || asset.caption),
        target: normalizeText(asset.target || asset.targetSection || asset.target_section),
        source: normalizeText(asset.source || asset.attribution),
        origin: normalizeText(asset.origin || asset.ownership),
        sourceIndex: index,
      };
    });
  }

  function availableTemplates() {
    var templates = namespace.templates || namespace.TEMPLATES || [];
    if (!templates.length && typeof require === "function") {
      try {
        templates = require("./templates.js").templates;
      } catch (_error) {
        templates = [];
      }
    }
    return templates;
  }

  function findTemplate(templateId) {
    var templates = availableTemplates();
    var index;
    for (index = 0; index < templates.length; index += 1) {
      if (templates[index].id === templateId) {
        return templates[index];
      }
    }
    for (index = 0; index < templates.length; index += 1) {
      if (templates[index].id === "generic-ja") {
        return templates[index];
      }
    }
    return {
      id: "generic-ja",
      language: "ja",
      requiredInputs: ["title", "objective", "method"],
      sections: [
        { id: "abstract", titleJa: "概要", titleEn: "Abstract" },
        { id: "introduction", titleJa: "はじめに", titleEn: "Introduction" },
        { id: "method", titleJa: "手法", titleEn: "Method" },
        { id: "results", titleJa: "結果", titleEn: "Results" },
        { id: "discussion", titleJa: "考察", titleEn: "Discussion" },
        { id: "conclusion", titleJa: "結論", titleEn: "Conclusion" },
        { id: "references", titleJa: "参考文献", titleEn: "References" },
      ],
    };
  }

  function normalizeProject(project) {
    var templateId = readValue(project, ["templateId", "template_id"]);
    var template = findTemplate(templateId || "generic-ja");
    var language = readValue(project, ["language", "paperLanguage", "paper_language"]);
    var fields = {};
    Object.keys(FIELD_ALIASES).forEach(function (name) {
      fields[name] = readField(project, name);
    });
    var source = isObject(project) ? project : {};
    var instructions = isObject(source.instructions) ? source.instructions : {};
    var explicitInstruction =
      readValue(project, ["overallInstruction", "overall_instruction"]) ||
      normalizeText(instructions.global);
    var presetInstruction = Array.isArray(instructions.presets)
      ? instructions.presets.map(normalizeText).filter(Boolean).join(" / ")
      : "";
    return {
      source: source,
      template: template,
      templateId: template.id,
      language: language === "en" ? "en" : language === "ja" ? "ja" : template.language || "ja",
      punctuation:
        readValue(project, ["punctuation"]) === "ja-standard"
          ? "ja-standard"
          : "ja-comma-period",
      fields: fields,
      editorial: {
        documentType: readValue(project, ["documentType", "document_type"]),
        field: readValue(project, ["field", "researchField", "research_field"]),
        pageTarget: readValue(project, ["pageTarget", "page_target"]),
        targetAudience: readValue(project, ["targetAudience", "target_audience"]),
        submissionNotes: readValue(project, ["submissionNotes", "submission_notes"]),
      },
      references: normalizeReferences(project),
      assets: normalizeAssets(project),
      overallInstruction: [explicitInstruction, presetInstruction].filter(Boolean).join(" / "),
      sectionInstructions:
        Object.keys(readObject(project, ["sectionInstructions", "section_instructions"])).length
          ? readObject(project, ["sectionInstructions", "section_instructions"])
          : isObject(instructions.sections)
            ? instructions.sections
            : {},
    };
  }

  function localized(language, japanese, english) {
    return language === "en" ? english : japanese;
  }

  function applyPunctuation(value, model) {
    if (model.language !== "ja" || model.punctuation !== "ja-comma-period") {
      return value;
    }
    return value.replace(/、/g, "，").replace(/。/g, "．");
  }

  function placeholder(kind, language, japanese, english) {
    return "[" + kind + ": " + localized(language, japanese, english) + "]";
  }

  function todo(language, japanese, english) {
    return placeholder("TODO", language, japanese, english);
  }

  function dataNeeded(language, japanese, english) {
    return placeholder("DATA NEEDED", language, japanese, english);
  }

  function figureNeeded(language, japanese, english) {
    return placeholder("FIGURE NEEDED", language, japanese, english);
  }

  function citationNeeded(language, japanese, english) {
    return placeholder("CITATION NEEDED", language, japanese, english);
  }

  function verify(language, japanese, english) {
    return placeholder("VERIFY", language, japanese, english);
  }

  function addEntry(lines, language, labelJa, labelEn, value, fallback) {
    lines.push(localized(language, labelJa, labelEn) + ":");
    lines.push(value || fallback);
    lines.push("");
  }

  function validReferences(model) {
    return model.references.filter(function (reference) {
      return reference.key && reference.title;
    });
  }

  function referencesText(model) {
    var language = model.language;
    var references = validReferences(model);
    if (!references.length) {
      return citationNeeded(
        language,
        "確認済みの参考文献を登録してください",
        "Add a verified reference supplied by the user"
      );
    }
    return references
      .map(function (reference) {
        var details = [reference.authors.join(", "), reference.year, reference.venue].filter(Boolean);
        return "[" + reference.key + "] " + reference.title + (details.length ? " — " + details.join("; ") : "");
      })
      .join("\n");
  }

  function assetsForSection(model, sectionId) {
    return model.assets.filter(function (asset) {
      return asset.name && asset.target === sectionId;
    });
  }

  function assetsText(model, sectionId, required) {
    var assets = assetsForSection(model, sectionId);
    if (!assets.length) {
      return required
        ? figureNeeded(
            model.language,
            "この節を裏付ける図表を追加し、キャプションと出典を確認してください",
            "Add a supporting figure or table and verify its caption and source"
          )
        : "";
    }
    return assets
      .map(function (asset) {
        var details = [asset.description];
        if (asset.origin === "cited" && asset.source) details.push("source: " + asset.source);
        return "- " + asset.name + (details.filter(Boolean).length ? ": " + details.filter(Boolean).join("; ") : "");
      })
      .join("\n");
  }

  function instructionText(model, sectionId) {
    var instruction = normalizeText(model.sectionInstructions[sectionId]);
    var combined = [model.overallInstruction, instruction].filter(Boolean).join(" / ");
    if (!combined) {
      return "";
    }
    return verify(
      model.language,
      "次のユーザー指示を、未確認の事実を追加せずに適用してください: " + combined,
      "Apply this user instruction without adding unsupported facts: " + combined
    );
  }

  function sectionTitle(sectionSpec, language) {
    if (language === "en") {
      return normalizeText(sectionSpec.titleEn || sectionSpec.title_en || sectionSpec.title) || sectionSpec.id;
    }
    return normalizeText(sectionSpec.titleJa || sectionSpec.title_ja || sectionSpec.title) || sectionSpec.id;
  }

  function draftSection(model, sectionSpec) {
    var language = model.language;
    var fields = model.fields;
    var id = sectionSpec.id;
    var lines = [];
    var figure;

    switch (id) {
      case "abstract":
        addEntry(
          lines,
          language,
          "研究目的",
          "Objective",
          fields.objective || fields.keyMessage,
          todo(language, "研究目的を1～2文で入力してください", "State the research objective in one or two sentences")
        );
        addEntry(
          lines,
          language,
          "手法",
          "Method",
          fields.method || fields.systemDesign || fields.simpleDescription,
          todo(language, "使用した手法を入力してください", "Describe the method used")
        );
        addEntry(
          lines,
          language,
          "結果",
          "Results",
          fields.results || fields.achievements,
          dataNeeded(language, "主要な測定結果を入力してください", "Provide the principal measured results")
        );
        addEntry(
          lines,
          language,
          "結論",
          "Conclusion",
          fields.conclusion || fields.keyMessage,
          verify(language, "結果から支持される結論だけを記述してください", "State only conclusions supported by the supplied results")
        );
        break;

      case "introduction":
        addEntry(
          lines,
          language,
          "背景",
          "Background",
          fields.background || fields.simpleDescription,
          todo(language, "研究背景と対象領域を入力してください", "Provide the research context")
        );
        addEntry(
          lines,
          language,
          "研究課題",
          "Problem",
          fields.problem || fields.bulletNotes,
          todo(language, "解決すべき課題を入力してください", "Define the problem to be addressed")
        );
        addEntry(
          lines,
          language,
          "目的",
          "Objective",
          fields.objective || fields.keyMessage,
          todo(language, "検証可能な研究目的を入力してください", "State a verifiable objective")
        );
        addEntry(
          lines,
          language,
          "新規性・貢献",
          "Novelty and contribution",
          fields.novelty || fields.achievements,
          verify(language, "既存研究との差分を確認して入力してください", "Verify and state the difference from prior work")
        );
        break;

      case "related-work":
        addEntry(lines, language, "登録済み文献", "Registered references", referencesText(model), "");
        lines.push(
          verify(
            language,
            "各文献の内容と本研究との関係を原文で確認してから記述してください",
            "Read each source and verify its relationship to this work before writing claims"
          )
        );
        break;

      case "method":
      case "proposed-method":
      case "proposed-approach":
      case "control-method":
        addEntry(
          lines,
          language,
          "手法",
          "Method",
          fields.method,
          todo(language, "手順、入力、出力、仮定を入力してください", "Provide the procedure, inputs, outputs, and assumptions")
        );
        if (fields.systemDesign) {
          addEntry(lines, language, "システム構成", "System design", fields.systemDesign, "");
        }
        figure = assetsText(model, id, true);
        addEntry(lines, language, "図表", "Figure or table", figure, "");
        break;

      case "system-design":
        addEntry(
          lines,
          language,
          "システム構成",
          "System design",
          fields.systemDesign,
          todo(language, "構成要素、接続、仕様を入力してください", "Provide components, connections, and specifications")
        );
        addEntry(lines, language, "構成図", "System figure", assetsText(model, id, true), "");
        break;

      case "experiments":
      case "experimental-setup":
      case "evaluation":
        addEntry(
          lines,
          language,
          "実験条件",
          "Experimental conditions",
          fields.experimentalConditions,
          dataNeeded(language, "対象、比較条件、試行回数、設定値を入力してください", "Provide subjects, baselines, trial count, and settings")
        );
        addEntry(
          lines,
          language,
          "評価指標",
          "Evaluation metrics",
          fields.metrics,
          dataNeeded(language, "評価指標と算出方法を入力してください", "Define each metric and its calculation")
        );
        addEntry(lines, language, "試行回数", "Trial count", fields.trialCount, "");
        addEntry(lines, language, "統計情報", "Statistical analysis", fields.statistics, "");
        addEntry(lines, language, "再現性情報", "Reproducibility details", fields.reproducibility, "");
        addEntry(lines, language, "実験図表", "Experimental figure", assetsText(model, id, true), "");
        if (id === "evaluation") {
          addEntry(
            lines,
            language,
            "結果",
            "Results",
            fields.results,
            dataNeeded(language, "観測結果を入力してください", "Provide observed results")
          );
        }
        break;

      case "evaluation-metrics":
        addEntry(
          lines,
          language,
          "評価指標",
          "Evaluation metrics",
          fields.metrics,
          dataNeeded(language, "指標の定義、単位、算出方法を入力してください", "Provide metric definitions, units, and calculations")
        );
        break;

      case "results":
        addEntry(
          lines,
          language,
          "観測結果",
          "Observed results",
          fields.results,
          dataNeeded(language, "測定値、試行回数、ばらつきを入力してください", "Provide measurements, trial count, and dispersion")
        );
        addEntry(lines, language, "試行回数", "Trial count", fields.trialCount, "");
        addEntry(lines, language, "統計情報", "Statistical analysis", fields.statistics, "");
        addEntry(lines, language, "結果図表", "Results figure", assetsText(model, id, true), "");
        lines.push(
          verify(
            language,
            "数値を原データと照合し、結果と解釈を分けてください",
            "Check every number against source data and separate observations from interpretation"
          )
        );
        break;

      case "results-discussion":
        addEntry(
          lines,
          language,
          "結果",
          "Results",
          fields.results,
          dataNeeded(language, "測定結果とばらつきを入力してください", "Provide measurements and dispersion")
        );
        addEntry(lines, language, "比較対象・基準", "Comparison or baseline", fields.comparison, "");
        addEntry(lines, language, "統計情報", "Statistical analysis", fields.statistics, "");
        addEntry(
          lines,
          language,
          "考察",
          "Discussion",
          fields.discussion,
          verify(language, "結果に基づく解釈と代替説明を入力してください", "Provide an interpretation and plausible alternatives grounded in the results")
        );
        addEntry(lines, language, "結果図表", "Results figure", assetsText(model, id, true), "");
        break;

      case "discussion":
      case "analysis":
        addEntry(
          lines,
          language,
          "考察",
          "Discussion",
          fields.discussion,
          verify(language, "入力済み結果の解釈、代替説明、誤差要因を記述してください", "Interpret the supplied results and consider alternatives and error sources")
        );
        addEntry(
          lines,
          language,
          "制約",
          "Limitations",
          fields.limitations,
          todo(language, "適用範囲と制約を入力してください", "State scope and limitations")
        );
        break;

      case "limitations":
      case "problems":
      case "risks":
        addEntry(
          lines,
          language,
          id === "risks" ? "リスクと代替策" : "制約・問題点",
          id === "risks" ? "Risks and contingencies" : "Limitations and problems",
          fields.limitations,
          todo(language, "既知の制約、失敗条件、代替策を入力してください", "Provide known limitations, failure conditions, and contingencies")
        );
        break;

      case "conclusion":
        addEntry(
          lines,
          language,
          "結論",
          "Conclusion",
          fields.conclusion,
          verify(language, "入力済み結果が支持する範囲で結論を入力してください", "State a conclusion limited to what the supplied results support")
        );
        addEntry(
          lines,
          language,
          "今後の課題",
          "Future work",
          fields.futureWork,
          todo(language, "未解決課題と次の検証を入力してください", "State unresolved questions and the next validation step")
        );
        break;

      case "references":
        lines.push(referencesText(model));
        break;

      case "background":
        addEntry(
          lines,
          language,
          "背景",
          "Background",
          fields.background,
          todo(language, "研究背景を入力してください", "Provide the research context")
        );
        break;

      case "problem":
      case "research-gaps":
        addEntry(
          lines,
          language,
          id === "problem" ? "研究課題" : "研究ギャップ",
          id === "problem" ? "Research problem" : "Research gaps",
          id === "problem" ? fields.problem : fields.researchGaps || fields.problem,
          verify(language, "文献と入力情報から確認できる未解決課題を入力してください", "State only gaps verified from the supplied sources")
        );
        break;

      case "objective":
      case "objectives":
        addEntry(
          lines,
          language,
          "研究目的",
          "Objectives",
          fields.objective,
          todo(language, "検証可能な目的を入力してください", "Provide verifiable objectives")
        );
        break;

      case "research-plan":
        addEntry(
          lines,
          language,
          "研究計画",
          "Research plan",
          fields.researchPlan || fields.method,
          todo(language, "作業項目、順序、完了条件を入力してください", "Provide tasks, sequence, and completion criteria")
        );
        break;

      case "expected-results":
        addEntry(
          lines,
          language,
          "期待結果（仮説）",
          "Expected results (hypotheses)",
          fields.expectedResults,
          todo(language, "期待結果を観測事実ではなく仮説として入力してください", "State expected outcomes as hypotheses, not observations")
        );
        lines.push(
          verify(
            language,
            "期待結果を実測済みの事実として表現していないことを確認してください",
            "Confirm that expected outcomes are not presented as observed facts"
          )
        );
        break;

      case "schedule":
        addEntry(
          lines,
          language,
          "スケジュール",
          "Schedule",
          fields.schedule,
          todo(language, "マイルストーンと時期を入力してください", "Provide milestones and dates")
        );
        break;

      case "search-strategy":
        addEntry(
          lines,
          language,
          "検索戦略",
          "Search strategy",
          fields.searchStrategy,
          dataNeeded(language, "検索DB、検索式、検索日、採択・除外基準を入力してください", "Provide databases, queries, dates, and inclusion/exclusion criteria")
        );
        break;

      case "classification":
        addEntry(
          lines,
          language,
          "分類軸",
          "Classification scheme",
          fields.classification,
          todo(language, "文献を分類する再現可能な基準を入力してください", "Provide reproducible classification criteria")
        );
        break;

      case "comparison":
        addEntry(lines, language, "比較対象", "Sources to compare", referencesText(model), "");
        addEntry(
          lines,
          language,
          "比較結果",
          "Comparison",
          fields.comparison || fields.results,
          dataNeeded(language, "各文献から確認した比較項目を入力してください", "Provide comparison data verified from each source")
        );
        break;

      case "equipment":
        addEntry(
          lines,
          language,
          "使用機器",
          "Equipment",
          fields.equipment,
          dataNeeded(language, "機器名、型式、仕様、校正情報を入力してください", "Provide equipment names, models, specifications, and calibration information")
        );
        break;

      case "conditions":
        addEntry(
          lines,
          language,
          "実験条件",
          "Conditions",
          fields.experimentalConditions,
          dataNeeded(language, "設定値、環境、試行回数を入力してください", "Provide settings, environment, and trial count")
        );
        addEntry(lines, language, "試行回数", "Trial count", fields.trialCount, "");
        addEntry(lines, language, "再現性情報", "Reproducibility details", fields.reproducibility, "");
        break;

      case "procedure":
        addEntry(
          lines,
          language,
          "実験手順",
          "Procedure",
          fields.method,
          todo(language, "再現可能な手順を順番に入力してください", "Provide the reproducible procedure in order")
        );
        break;

      default:
        addEntry(
          lines,
          language,
          "本文",
          "Content",
          "",
          todo(language, "このセクションの根拠となる情報を入力してください", "Provide source information for this section")
        );
    }

    var instruction = instructionText(model, id);
    if (instruction) {
      lines.push("");
      lines.push(instruction);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function sectionSpecs(model) {
    var sourceSections = readArray(model.source, ["sections"]);
    if (!sourceSections.length && isObject(model.source.manuscript) && Array.isArray(model.source.manuscript.sections)) {
      sourceSections = model.source.manuscript.sections;
    }
    if (!sourceSections.length) {
      return model.template.sections.slice();
    }
    return sourceSections.map(function (item, index) {
      if (typeof item === "string") {
        item = { id: item };
      }
      var value = isObject(item) ? item : {};
      var id = normalizeText(value.id || value.sectionId || value.section_id) || "section-" + (index + 1);
      var templateSection = null;
      (model.template.sections || []).some(function (candidate) {
        if (candidate.id === id) {
          templateSection = candidate;
          return true;
        }
        return false;
      });
      return {
        id: id,
        content: normalizeText(value.content || value.body || value.text),
        preserveContent: !templateSection,
        title: normalizeText(value.title) || (templateSection && templateSection.title) || id,
        titleJa:
          normalizeText(value.titleJa || value.title_ja) ||
          (templateSection && normalizeText(templateSection.titleJa || templateSection.title_ja)),
        titleEn:
          normalizeText(value.titleEn || value.title_en) ||
          (templateSection && normalizeText(templateSection.titleEn || templateSection.title_en)),
      };
    });
  }

  function generateManuscript(project) {
    var model = normalizeProject(project);
    var sections = sectionSpecs(model).map(function (spec) {
      var content = spec.preserveContent ? spec.content : applyPunctuation(draftSection(model, spec), model);
      return {
        id: spec.id,
        title: sectionTitle(spec, model.language),
        content: content,
        text: content,
      };
    });
    var byId = Object.create(null);
    sections.forEach(function (section) {
      byId[section.id] = section.text;
    });
    var title = model.fields.title || todo(model.language, "論文タイトルを入力してください", "Provide the paper title");
    var text = ["# " + title]
      .concat(
        sections.map(function (section) {
          return "## " + section.title + "\n\n" + section.text;
        })
      )
      .join("\n\n");
    return {
      title: title,
      language: model.language,
      templateId: model.templateId,
      metadata: {
        documentType: model.editorial.documentType,
        field: model.editorial.field,
        pageTarget: model.editorial.pageTarget,
        targetAudience: model.editorial.targetAudience,
        submissionNotes: model.editorial.submissionNotes,
      },
      sections: sections,
      byId: byId,
      text: text,
    };
  }

  function advice(id, severity, language, titleJa, titleEn, reasonJa, reasonEn, target, actionJa, actionEn) {
    return {
      id: id,
      severity: severity,
      title: localized(language, titleJa, titleEn),
      reason: localized(language, reasonJa, reasonEn),
      target: target,
      action: localized(language, actionJa, actionEn),
      resolved: false,
    };
  }

  function manuscriptBody(manuscript, omitReferences) {
    if (typeof manuscript === "string") {
      return normalizeText(manuscript);
    }
    if (!isObject(manuscript)) {
      return "";
    }
    if (Array.isArray(manuscript.sections)) {
      return manuscript.sections
        .filter(function (section) {
          return !omitReferences || section.id !== "references";
        })
        .map(function (section) {
          return normalizeText(section.text || section.content);
        })
        .filter(Boolean)
        .join("\n");
    }
    return normalizeText(manuscript.text || manuscript.content);
  }

  function targetForField(field) {
    var targets = {
      title: "metadata",
      background: "introduction",
      problem: "introduction",
      objective: "introduction",
      novelty: "introduction",
      method: "method",
      systemDesign: "system-design",
      experimentalConditions: "experiments",
      comparison: "experiments",
      trialCount: "experiments",
      reproducibility: "experiments",
      metrics: "evaluation-metrics",
      statistics: "results",
      results: "results",
      references: "references",
    };
    return targets[field] || field;
  }

  function hasMultipleTrials(value) {
    var normalized = normalizeText(value).toLowerCase();
    var numeric = normalized.match(/(?:^|[^0-9.])([0-9]+(?:\.[0-9]+)?)(?:[^0-9.]|$)/);
    if (numeric && Number(numeric[1]) > 1) {
      return true;
    }
    return /複数|反復|繰り返|multiple|repeated|replicates?/.test(normalized);
  }

  function analyzeProject(project, manuscript) {
    var model = normalizeProject(project);
    var language = model.language;
    var generated = manuscript || generateManuscript(project);
    var body = manuscriptBody(generated, false);
    var proseBody = manuscriptBody(generated, true);
    var items = [];
    var seen = Object.create(null);

    function add(item) {
      if (!seen[item.id]) {
        seen[item.id] = true;
        items.push(item);
      }
    }

    (model.template.requiredInputs || []).forEach(function (field) {
      var missing = field === "references" ? !validReferences(model).length : !model.fields[field];
      if (!missing) {
        return;
      }
      add(
        advice(
          "missing." + field,
          "required",
          language,
          field === "title" ? "論文タイトルを入力してください" : "必須情報が不足しています",
          field === "title" ? "Add the paper title" : "Required information is missing",
          "テンプレートの必須入力「" + field + "」が空です。",
          'The template requires the field "' + field + '", but it is empty.',
          targetForField(field),
          "確認済みの情報だけを入力してください。",
          "Enter only information that has been verified."
        )
      );
    });

    if (model.fields.method && !model.fields.novelty && model.templateId !== "experiment-report") {
      add(
        advice(
          "structure.novelty",
          "required",
          language,
          "新規性を明示してください",
          "State the novelty",
          "手法は入力されていますが、既存手法との差分が入力されていません。",
          "A method is present, but its verified difference from prior work is missing.",
          "introduction",
          "確認済み文献に基づき、差分とその意義を入力してください。",
          "Use verified sources to state the difference and why it matters."
        )
      );
    }

    if (model.fields.results && !model.fields.experimentalConditions) {
      add(
        advice(
          "reproducibility.conditions",
          "required",
          language,
          "実験条件を追加してください",
          "Add experimental conditions",
          "結果はありますが、その取得条件を再現できません。",
          "Results are present, but the conditions needed to reproduce them are missing.",
          "experiments",
          "対象、設定値、比較条件、試行回数を入力してください。",
          "Provide subjects, settings, baselines, and trial count."
        )
      );
    }

    if (model.fields.results && !model.fields.metrics) {
      add(
        advice(
          "reproducibility.metrics",
          "recommended",
          language,
          "評価指標を定義してください",
          "Define evaluation metrics",
          "結果を解釈するための指標と算出方法がありません。",
          "The metrics and calculations needed to interpret the results are missing.",
          "evaluation-metrics",
          "名称、単位、算出式を入力してください。",
          "Provide names, units, and calculations."
        )
      );
    }

    if (model.fields.results && model.fields.experimentalConditions && !model.fields.trialCount) {
      add(
        advice(
          "reproducibility.trial-count",
          "recommended",
          language,
          "試行回数を明示してください",
          "State the trial count",
          "結果と実験条件はありますが，試行回数が独立した情報として登録されていません。",
          "Results and conditions are present, but the trial count is not recorded explicitly.",
          "experiments",
          "総試行回数，除外数，反復単位を入力してください。",
          "Provide the total trials, exclusions, and unit of replication."
        )
      );
    }

    if (model.fields.results && hasMultipleTrials(model.fields.trialCount) && !model.fields.statistics) {
      add(
        advice(
          "reproducibility.statistics",
          "recommended",
          language,
          "ばらつきや統計処理を記録してください",
          "Record dispersion or statistical analysis",
          "複数回の試行結果がありますが，ばらつき，信頼区間，または統計処理が登録されていません。",
          "Multiple trials are recorded, but dispersion, confidence intervals, or statistical analysis are missing.",
          "results",
          "実施した場合だけ，標準偏差，信頼区間，検定手順などを入力してください。",
          "If performed, provide dispersion, confidence intervals, or the statistical procedure used."
        )
      );
    }

    if (model.editorial.pageTarget || model.editorial.targetAudience || model.editorial.submissionNotes) {
      var editorialSummary = [
        model.editorial.documentType && "document=" + model.editorial.documentType,
        model.editorial.field && "field=" + model.editorial.field,
        model.editorial.pageTarget && "pages=" + model.editorial.pageTarget,
        model.editorial.targetAudience && "audience=" + model.editorial.targetAudience,
        model.editorial.submissionNotes && "submission=" + model.editorial.submissionNotes,
      ].filter(Boolean).join(" / ");
      add(
        advice(
          "editorial.constraints",
          "optional",
          language,
          "投稿条件を最終確認してください",
          "Check the editorial constraints",
          "編集用メモ：" + editorialSummary,
          "Editorial notes: " + editorialSummary,
          "metadata",
          "ページ数，対象読者，投稿先書式は自動適合を保証しないため，書き出し後に確認してください。",
          "Page count, audience, and venue formatting are not enforced automatically; verify them after export."
        )
      );
    }

    if (model.fields.experimentalConditions && !model.fields.comparison) {
      add(
        advice(
          "evaluation.comparison",
          "optional",
          language,
          "比較対象を確認してください",
          "Check the comparison baseline",
          "実験条件はありますが，比較対象または基準値が登録されていません。",
          "Experimental conditions are present, but no baseline or comparator is recorded.",
          "experiments",
          "比較を行った場合だけ，対象，選定理由，同一条件を入力してください。",
          "If a comparison was performed, provide the comparator, rationale, and matched conditions."
        )
      );
    }

    if (
      (model.fields.method || model.fields.experimentalConditions) &&
      !model.fields.reproducibility &&
      model.templateId !== "literature-review"
    ) {
      add(
        advice(
          "reproducibility.details",
          "recommended",
          language,
          "再現性情報を追加してください",
          "Add reproducibility details",
          "手法または実験条件はありますが，再実施に必要な補足情報がありません。",
          "A method or experiment is present, but supporting details for repeating it are missing.",
          "experiments",
          "ソフトウェア版，乱数条件，前処理，公開データの場所を入力してください。",
          "Provide software versions, randomization, preprocessing, and data availability."
        )
      );
    }

    if (
      !model.fields.results &&
      model.templateId !== "research-proposal" &&
      model.templateId !== "literature-review"
    ) {
      add(
        advice(
          "data.results",
          "required",
          language,
          "結果データを追加してください",
          "Add result data",
          "観測結果がないため、結果や結論を確定できません。",
          "No observed result was supplied, so results and conclusions cannot be completed.",
          "results",
          "測定値、試行回数、ばらつき、原データを入力してください。",
          "Provide measurements, trial count, dispersion, and source data."
        )
      );
    }

    if (!validReferences(model).length) {
      add(
        advice(
          "references.none",
          model.templateId === "literature-review" ? "required" : "recommended",
          language,
          "確認済み参考文献を登録してください",
          "Add verified references",
          "参考文献が登録されていません。生成器は文献を推測しません。",
          "No references are registered, and the generator will not invent them.",
          "references",
            "手入力またはBibTeXから、実在を確認した文献を追加してください。",
            "Add references verified by the user manually or from BibTeX."
        )
      );
    }

    var projectSections = isObject(model.source.manuscript) && Array.isArray(model.source.manuscript.sections)
      ? model.source.manuscript.sections
      : model.template.sections || [];
    var validSectionIds = Object.create(null);
    projectSections.forEach(function (section) {
      var id = section && normalizeText(section.id);
      if (id && id !== "references" && id !== "bibliography") validSectionIds[id] = true;
    });
    model.assets.forEach(function (asset) {
      if (!asset.target || !validSectionIds[asset.target]) {
        add(
          advice(
            "assets.target." + asset.sourceIndex,
            "required",
            language,
            "図表・データの使用箇所を選んでください",
            "Choose where the asset is used",
            '「' + asset.name + '」の使用予定セクションが未選択または無効です。',
            'The target section for "' + asset.name + '" is missing or no longer exists.',
            "assets",
            "編集画面の図・データタブで使用予定セクションを選んでください。",
            "Select a target section in the Assets panel."
          )
        );
      }
      if (!asset.description) {
        add(
          advice(
            "assets.caption." + asset.sourceIndex,
            "recommended",
            language,
            "図表・データの説明を追加してください",
            "Add an asset caption or description",
            '「' + asset.name + '」の説明がありません。',
            'No caption or description is supplied for "' + asset.name + '".',
            "assets",
            "何を示すファイルか，本文だけでも分かる説明を入力してください。",
            "Describe what the file shows so it can be understood from the paper."
          )
        );
      }
      if (asset.origin === "cited" && !asset.source) {
        add(
          advice(
            "assets.source." + asset.sourceIndex,
            "required",
            language,
            "引用図表の出典を追加してください",
            "Add the source for the cited asset",
            '「' + asset.name + '」は引用・転載ですが出典がありません。',
            '"' + asset.name + '" is marked as cited, but its source is missing.',
            "assets",
            "原典と利用条件を確認し，出典を入力してください。",
            "Verify the original and its reuse terms, then enter the source."
          )
        );
      }
    });

    var keyCounts = Object.create(null);
    model.references.forEach(function (reference) {
      if (!reference.key || !reference.title) {
        add(
          advice(
            "references.incomplete." + reference.sourceIndex,
            "required",
            language,
            "参考文献情報を補完してください",
            "Complete the reference",
            "citation keyまたはタイトルがありません。",
            "The citation key or title is missing.",
            "references",
            "原典を確認してkeyとタイトルを入力してください。",
            "Check the source and provide its key and title."
          )
        );
      }
      if (reference.key) {
        keyCounts[reference.key] = (keyCounts[reference.key] || 0) + 1;
      }
      if (
        reference.year &&
        typeof namespace.normalizeReferenceDate === "function" &&
        !namespace.normalizeReferenceDate(reference.year)
      ) {
        add(
          advice(
            "references.date." + reference.sourceIndex,
            "required",
            language,
            "文献の日付形式を修正してください",
            "Fix the reference date",
            "文献の日付がISO形式ではありません。",
            "The reference date is not in a supported ISO format.",
            "references",
            "YYYY，YYYY-MM，YYYY-MM-DD のいずれかで入力してください。",
            "Use YYYY, YYYY-MM, or YYYY-MM-DD."
          )
        );
      }
    });
    Object.keys(keyCounts)
      .sort()
      .forEach(function (key) {
        if (keyCounts[key] > 1) {
          add(
            advice(
              "references.duplicate." + key,
              "required",
              language,
              "引用キーが重複しています",
              "Duplicate citation key",
              '引用キー「' + key + '」が' + keyCounts[key] + "件あります。",
              'The citation key "' + key + '" occurs ' + keyCounts[key] + " times.",
              "references",
              "各文献に一意な引用キーを割り当ててください。",
              "Assign a unique citation key to every reference."
            )
          );
        }
      });

    var cited = Object.create(null);
    // A citation marker must start at a text boundary. This keeps addresses such
    // as alice@example.com from being reported as unknown citations.
    var citationPattern = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_](?:[A-Za-z0-9_.:-]*[A-Za-z0-9_])?)/g;
    var match;
    while ((match = citationPattern.exec(proseBody)) !== null) {
      cited[match[2]] = true;
    }
    var knownKeys = Object.create(null);
    validReferences(model).forEach(function (reference) {
      knownKeys[reference.key] = true;
    });
    Object.keys(cited)
      .sort()
      .forEach(function (key) {
        if (!knownKeys[key]) {
          add(
            advice(
              "references.unknown." + key,
              "required",
              language,
              "存在しない引用キーがあります",
              "Unknown citation key",
              '本文の「@' + key + '」に対応する登録文献がありません。',
              'The citation "@' + key + '" has no registered reference.',
              "references",
              "原典を確認して文献を登録するか、引用を削除してください。",
              "Verify and register the source, or remove the citation."
            )
          );
        }
      });

    validReferences(model).forEach(function (reference) {
      if (!cited[reference.key]) {
        add(
          advice(
            "references.unused." + reference.key,
            "optional",
            language,
            "本文で未使用の文献があります",
            "Reference is not cited",
            '登録文献「' + reference.key + '」は本文で引用されていません。',
            'The registered reference "' + reference.key + '" is not cited in the manuscript.',
            "references",
            "必要なら本文で根拠として使用し、不要なら登録から外してください。",
            "Cite it where it supports a verified claim, or remove it if unnecessary."
          )
        );
      }
    });

    if (!model.fields.limitations) {
      add(
        advice(
          "claims.limitations",
          "recommended",
          language,
          "制約と適用範囲を追加してください",
          "Add limitations and scope",
          "主張の適用範囲を判断するための制約が入力されていません。",
          "No limitations are supplied to bound the claims.",
          "discussion",
          "既知の制約、失敗条件、未検証条件を入力してください。",
          "Provide known limitations, failure conditions, and untested conditions."
        )
      );
    }

    if (!model.fields.futureWork) {
      add(
        advice(
          "structure.future-work",
          "optional",
          language,
          "今後の課題を追加できます",
          "Consider adding future work",
          "次に検証すべき内容が入力されていません。",
          "The next validation step is not supplied.",
          "conclusion",
          "未解決課題と具体的な次の検証を入力してください。",
          "Provide unresolved questions and a concrete next validation step."
        )
      );
    }

    var placeholderRules = [
      ["[TODO:", "placeholders.todo", "recommended", "未入力項目があります", "Some fields are incomplete"],
      ["[DATA NEEDED:", "placeholders.data", "required", "根拠データが必要です", "Source data is required"],
      ["[FIGURE NEEDED:", "placeholders.figure", "recommended", "図表の追加を検討してください", "Consider adding a figure or table"],
      ["[CITATION NEEDED:", "placeholders.citation", "required", "確認済み引用が必要です", "A verified citation is required"],
      ["[VERIFY:", "placeholders.verify", "recommended", "確認が必要な記述があります", "Some statements require verification"],
    ];
    placeholderRules.forEach(function (rule) {
      if (body.indexOf(rule[0]) !== -1) {
        add(
          advice(
            rule[1],
            rule[2],
            language,
            rule[3],
            rule[4],
            "原稿に「" + rule[0].slice(1, -1) + "」プレースホルダーが残っています。",
            'The manuscript still contains a "' + rule[0].slice(1, -1) + '" placeholder.',
            "manuscript",
            "プレースホルダーを検索し、確認済み情報で置き換えてください。",
            "Find the placeholder and replace it with verified information."
          )
        );
      }
    });

    return items;
  }

  function regenerateSection(project, sectionId, currentText) {
    var model = normalizeProject(project);
    var id = normalizeText(sectionId) || "section";
    var specs = sectionSpecs(model);
    var selected = null;
    var index;
    for (index = 0; index < specs.length; index += 1) {
      if (specs[index].id === id) {
        selected = specs[index];
        break;
      }
    }
    if (!selected) {
      selected = { id: id, title: id, titleJa: id, titleEn: id };
    }
    var draft = draftSection(model, selected);
    var previous = normalizeText(currentText);
    var hasProjectContent = Object.keys(model.fields).some(function (field) {
      return model.fields[field] && draft.indexOf(model.fields[field]) !== -1;
    });
    if (!hasProjectContent && previous) {
      return applyPunctuation(
        previous +
        "\n\n" +
        verify(
          model.language,
          "構造化入力が不足しているため既存文を保持しました。内容と根拠を確認してください",
          "The existing text was preserved because structured input is missing; verify its content and evidence"
        ),
        model,
      );
    }
    return applyPunctuation(draft, model);
  }

  return {
    generateManuscript: generateManuscript,
    analyzeProject: analyzeProject,
    regenerateSection: regenerateSection,
  };
});
