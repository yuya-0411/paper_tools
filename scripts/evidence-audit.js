(function (root, factory) {
  "use strict";

  var namespace = root.PaperTools || (root.PaperTools = {});
  var api = factory(namespace);
  root.PaperTools = Object.assign(namespace, api);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (PaperTools) {
  "use strict";

  var DEFAULT_LIMITS = Object.freeze({
    maxSections: 100,
    maxAssets: 200,
    maxFindings: 200,
    maxTextChars: 500000,
    maxExcerptChars: 220,
  });

  var FIELD_ALIASES = {
    method: ["method", "procedure", "approach", "systemDesign"],
    systemDesign: ["systemDesign", "architecture"],
    results: ["results", "achievements", "observations"],
    experimentalConditions: ["experimentalConditions", "experiment", "conditions"],
    trialCount: ["trialCount", "trials", "numberOfTrials"],
    statistics: ["statistics", "statisticalAnalysis", "dispersion"],
    comparison: ["comparison", "baseline", "baselines"],
    dataAvailability: ["dataAvailability", "dataSource", "provenance"],
    searchStrategy: ["searchStrategy"],
    researchPlan: ["researchPlan"],
    schedule: ["schedule"],
  };

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function clampInteger(value, fallback, minimum, maximum) {
    var parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function limitsFrom(options) {
    var source = isObject(options) ? options : {};
    return {
      maxSections: clampInteger(source.maxSections, DEFAULT_LIMITS.maxSections, 1, 200),
      maxAssets: clampInteger(source.maxAssets, DEFAULT_LIMITS.maxAssets, 1, 500),
      maxFindings: clampInteger(source.maxFindings, DEFAULT_LIMITS.maxFindings, 1, 500),
      maxTextChars: clampInteger(source.maxTextChars, DEFAULT_LIMITS.maxTextChars, 10000, 1000000),
      maxExcerptChars: clampInteger(source.maxExcerptChars, DEFAULT_LIMITS.maxExcerptChars, 80, 500),
    };
  }

  function text(value, maximum) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\r\n?/g, "\n")
      .slice(0, maximum || 100000)
      .trim();
  }

  function lower(value, maximum) {
    return text(value, maximum).toLocaleLowerCase("en-US");
  }

  function localized(language, ja, en) {
    return language === "en" ? en : ja;
  }

  function readField(source, name) {
    var research = isObject(source.research) ? source.research : {};
    var aliases = FIELD_ALIASES[name] || [name];
    var containers = [research, source];
    for (var containerIndex = 0; containerIndex < containers.length; containerIndex += 1) {
      for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
        var key = aliases[aliasIndex];
        if (hasOwn(containers[containerIndex], key)) {
          var value = text(containers[containerIndex][key], 50000);
          if (value) return value;
        }
      }
    }
    return "";
  }

  function resolveTemplate(source) {
    if (isObject(source.templateDefinition)) return source.templateDefinition;
    if (isObject(source.template) && Array.isArray(source.template.sections)) return source.template;
    var id = text(source.templateId, 100);
    if (PaperTools.templateMap && isObject(PaperTools.templateMap[id])) {
      return PaperTools.templateMap[id];
    }
    if (typeof PaperTools.getTemplate === "function") {
      try {
        return PaperTools.getTemplate(id) || {};
      } catch (_error) {
        return {};
      }
    }
    return {};
  }

  function normalizeSections(source, template, limits) {
    var manuscript = isObject(source.manuscript) ? source.manuscript : {};
    var raw = Array.isArray(manuscript.sections)
      ? manuscript.sections
      : Array.isArray(source.sections)
        ? source.sections
        : Array.isArray(template.sections)
          ? template.sections
          : [];
    var remaining = limits.maxTextChars;
    return raw.slice(0, limits.maxSections).map(function (item, index) {
      var section = isObject(item) ? item : { id: item };
      var content = text(section.content || section.text || section.body, Math.max(0, remaining));
      remaining = Math.max(0, remaining - content.length);
      return {
        id: text(section.id || section.sectionId, 100) || "section-" + (index + 1),
        title: text(section.title || section.titleJa || section.titleEn, 300),
        content: content,
      };
    });
  }

  function payloadAvailable(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.length > 0;

    var runtime = typeof globalThis !== "undefined" ? globalThis : {};
    try {
      if (typeof runtime.Blob === "function" && value instanceof runtime.Blob) return value.size > 0;
      if (typeof runtime.ArrayBuffer === "function") {
        if (value instanceof runtime.ArrayBuffer) return value.byteLength > 0;
        if (typeof runtime.ArrayBuffer.isView === "function" && runtime.ArrayBuffer.isView(value)) return value.byteLength > 0;
      }
    } catch (_error) {
      return false;
    }
    return false;
  }

  function assetPayloadAvailable(asset) {
    if (!isObject(asset)) return payloadAvailable(asset);
    return [asset.data, asset.blob, asset.file, asset.bytes, asset.binary, asset.content].some(payloadAvailable);
  }

  function normalizeAssets(source, limits) {
    var raw = Array.isArray(source.assets) ? source.assets : [];
    return raw.slice(0, limits.maxAssets).map(function (item, index) {
      var asset = isObject(item) ? item : {};
      return {
        index: index,
        id: text(asset.id, 120) || "asset-" + (index + 1),
        name: text(asset.displayName || asset.name || asset.filename, 300) || "asset-" + (index + 1),
        filename: text(asset.name || asset.filename, 300),
        role: lower(asset.role || "other", 40),
        target: text(asset.target || asset.targetSection, 100),
        caption: text(asset.caption || asset.description, 2000),
        source: text(asset.source || asset.citation || asset.provenance, 2000),
        origin: lower(asset.origin || "unknown", 40),
        size: Math.max(0, Number(asset.size) || 0),
        hasPayload: assetPayloadAvailable(asset),
      };
    });
  }

  function sectionKind(section) {
    var value = lower((section.id || "") + " " + (section.title || ""), 500);
    if (/reference|bibliograph|参考文献|引用文献/.test(value)) return "references";
    if (/result|evaluation|analysis|discussion|comparison|finding|結果|評価|分析|考察|比較|観測/.test(value)) return "results";
    if (/search|classif|review|survey|検索|分類|レビュー/.test(value)) return "review";
    if (/schedule|timeline|research-plan|work-plan|計画|予定|スケジュール/.test(value)) return "plan";
    if (/method|approach|procedure|system|design|control|equipment|setup|condition|experiment|手法|方法|提案|システム|設計|制御|装置|手順|実験|条件/.test(value)) return "method";
    return "other";
  }

  function targetFor(sections, kind, preferredIds) {
    var preferred = preferredIds || [];
    var byId = Object.create(null);
    sections.forEach(function (section) {
      byId[section.id] = section;
    });
    for (var index = 0; index < preferred.length; index += 1) {
      if (byId[preferred[index]]) return byId[preferred[index]];
    }
    return sections.find(function (section) {
      return sectionKind(section) === kind;
    }) || sections.find(function (section) {
      return sectionKind(section) !== "references";
    }) || { id: "manuscript", title: "" };
  }

  function isVisual(asset) {
    return asset.role === "figure" || asset.role === "table";
  }

  function isDataAsset(asset) {
    var extension = lower(asset.filename, 300).match(/\.([a-z0-9]+)$/);
    return asset.role === "data" || Boolean(extension && /^(csv|json|ya?ml|txt|tsv|xlsx?)$/.test(extension[1]));
  }

  function assetTargetsKind(asset, kind, sectionById) {
    return Boolean(asset.target && sectionById[asset.target] && sectionKind(sectionById[asset.target]) === kind);
  }

  function looksLikeDiagram(asset) {
    return isVisual(asset) && /architecture|configuration|system|block|flow|pipeline|setup|schematic|apparatus|構成|システム|ブロック|フロー|流れ|模式|装置|実験環境/.test(
      lower(asset.name + " " + asset.caption, 2600),
    );
  }

  function numericFragments(values, limits) {
    var combined = values.filter(Boolean).join("\n").slice(0, limits.maxTextChars);
    var fragments = combined.split(/[。！？!?\n]+/).slice(0, 2000);
    var claims = [];
    var numericWithUnit = /(?:^|[^\d])\d+(?:[.,]\d+)?\s*(?:%|％|ms|s|sec|seconds?|秒|分|時間|mm|cm|km|m\b|kg|g\b|n\b|hz|khz|mhz|db|℃|°c|件|人|台|回|試行|samples?|subjects?|participants?|folds?|倍|ポイント)/i;
    var statistical = /(?:p\s*[<=>]\s*0?\.\d+|(?:mean|average|median|accuracy|precision|recall|score|平均|中央値|精度|再現率|適合率|成功率)[^。\n]{0,80}\d)/i;
    var decimal = /(?:増加|減少|改善|向上|低下|差|compared|improv|increase|decrease|higher|lower)[^。\n]{0,80}\d+(?:[.,]\d+)?/i;
    fragments.forEach(function (fragment) {
      var candidate = text(fragment, 1000);
      if (candidate && (numericWithUnit.test(candidate) || statistical.test(candidate) || decimal.test(candidate))) {
        claims.push(candidate);
      }
    });
    return claims.slice(0, 12);
  }

  function excerpt(value, limits) {
    var clean = text(value, limits.maxExcerptChars + 1).replace(/\s+/g, " ");
    if (clean.length <= limits.maxExcerptChars) return clean;
    return clean.slice(0, Math.max(1, limits.maxExcerptChars - 1)).trimEnd() + "…";
  }

  function auditEvidence(project, options) {
    var limits = limitsFrom(options);
    var source = isObject(project) ? project : {};
    var language = source.language === "en" ? "en" : "ja";
    var template = resolveTemplate(source);
    var templateId = text(source.templateId || template.id, 100);
    var documentType = lower(source.documentType || template.type, 100);
    var sections = normalizeSections(source, template, limits);
    var assets = normalizeAssets(source, limits);
    var references = Array.isArray(source.references) ? source.references.slice(0, 1000) : [];
    var sectionById = Object.create(null);
    sections.forEach(function (section) {
      sectionById[section.id] = section;
    });

    var methodTarget = targetFor(sections, "method", [
      "system-design", "method", "proposed-method", "control-method", "experimental-setup", "experiments", "procedure",
    ]);
    var resultsTarget = targetFor(sections, "results", [
      "results", "results-discussion", "evaluation", "analysis", "comparison", "expected-results",
    ]);
    var planTarget = targetFor(sections, "plan", ["research-plan", "schedule"]);
    var reviewTarget = targetFor(sections, "review", ["search-strategy", "classification", "comparison"]);

    var methodText = [readField(source, "method"), readField(source, "systemDesign")]
      .concat(sections.filter(function (section) { return sectionKind(section) === "method"; }).map(function (section) { return section.content; }))
      .filter(Boolean)
      .join("\n");
    var resultsText = [readField(source, "results")]
      .concat(sections.filter(function (section) { return sectionKind(section) === "results"; }).map(function (section) { return section.content; }))
      .filter(Boolean)
      .join("\n");
    var nonReferenceText = sections.filter(function (section) {
      return sectionKind(section) !== "references";
    }).map(function (section) {
      return section.content;
    });
    var claims = numericFragments([readField(source, "results")].concat(nonReferenceText), limits);
    var resultVisuals = assets.filter(function (asset) {
      return asset.hasPayload && isVisual(asset) && assetTargetsKind(asset, "results", sectionById);
    });
    var methodDiagrams = assets.filter(function (asset) {
      return asset.hasPayload && looksLikeDiagram(asset) && assetTargetsKind(asset, "method", sectionById);
    });
    var resultData = assets.filter(function (asset) {
      return asset.hasPayload && isDataAsset(asset) && (assetTargetsKind(asset, "results", sectionById) || !asset.target);
    });
    var allAnalysisText = lower(methodText + "\n" + resultsText, limits.maxTextChars);
    var trialCount = readField(source, "trialCount");
    var statistics = readField(source, "statistics");
    var comparison = readField(source, "comparison");
    var dataAvailability = readField(source, "dataAvailability");
    var hasTrialCount = Boolean(trialCount) || /(?:\bn\s*=\s*\d+|\d+\s*(?:試行|回(?:測定|実験)?|反復|samples?|subjects?|participants?|replicates?|trials?|runs?))/i.test(allAnalysisText);
    var hasVariability = Boolean(statistics) || /standard deviation|std\.?|\bsd\b|variance|confidence interval|\bci\b|interquartile|\biqr\b|error bars?|p[- ]?value|標準偏差|分散|信頼区間|四分位|誤差棒|有意差/.test(allAnalysisText);
    var hasComparison = Boolean(comparison) || /baseline|control group|compared (?:with|to)|versus|\bvs\.?\b|従来法|既存手法|ベースライン|対照群|比較対象/.test(allAnalysisText);
    var claimText = claims.join("\n");
    var hasCitation = /@[a-z0-9_.:-]+|\[[0-9][0-9,;\-\s]*\]|\([a-z][^)]*,\s*(?:19|20)\d{2}\)/i.test(claimText);
    var hasTraceableSource = Boolean(dataAvailability || resultData.length || hasCitation);
    var experimentalCue = /experiment|evaluation|measurement|trial|test set|実験|評価|測定|試行|検証|被験/.test(allAnalysisText);
    var projectIsReview = /literature-review|survey|review/.test(templateId + " " + documentType);
    var projectIsProposal = /research-proposal|grant-draft|proposal/.test(templateId + " " + documentType);
    var experimentLike = !projectIsReview && !projectIsProposal && (
      experimentalCue || Boolean(readField(source, "experimentalConditions")) || /robot|experiment|laboratory|engineering/.test(templateId + " " + documentType)
    );

    var findings = [];
    var seen = Object.create(null);
    var omittedFindings = 0;

    function add(ruleId, status, category, titleJa, titleEn, reasonJa, reasonEn, actionJa, actionEn, target, formatJa, formatEn, evidence, assetId) {
      if (seen[ruleId]) return;
      seen[ruleId] = true;
      if (findings.length >= limits.maxFindings) {
        omittedFindings += 1;
        return;
      }
      var targetSection = target && target.id ? target.id : text(target, 100) || "manuscript";
      var targetTitle = target && target.title ? target.title : "";
      findings.push({
        id: "evidence." + ruleId,
        ruleId: ruleId,
        status: status,
        category: category,
        title: localized(language, titleJa, titleEn),
        reason: localized(language, reasonJa, reasonEn),
        action: localized(language, actionJa, actionEn),
        targetSection: targetSection,
        targetSectionTitle: targetTitle,
        recommendedFormat: localized(language, formatJa, formatEn),
        evidence: (evidence || []).slice(0, 3).map(function (item) { return excerpt(item, limits); }).filter(Boolean),
        assetId: assetId || "",
      });
    }

    if (resultsText && !projectIsProposal && !projectIsReview) {
      if (!resultVisuals.length) {
        add(
          "results.visual", "recommended", "presentation",
          "結果を示す図または表を追加する", "Add a result figure or table",
          claims.length
            ? "数値的な結果が文章だけで示されており、傾向・差・条件を読み比べにくいためです。"
            : "結果が文章だけで示されており、主要な観測結果を短時間で確認しにくいためです。",
          claims.length
            ? "Numeric results are only stated in prose, making trends, differences, and conditions hard to compare."
            : "Results are only stated in prose, making the main observations difficult to scan.",
          "確認済みの結果だけを抽出し、軸・単位・条件・標本数を明記した図表を追加してください。",
          "Add a figure or table using only verified results, with axes, units, conditions, and sample size.",
          resultsTarget,
          claims.length ? "比較表、棒グラフ、折れ線図、散布図（必要なら誤差表現付き）" : "結果表、代表例、分類図",
          claims.length ? "Comparison table, bar/line/scatter plot, with uncertainty where applicable" : "Result table, representative examples, or classification diagram",
          claims,
        );
      } else {
        add(
          "results.visual", "ok", "presentation",
          "結果を示す図表があります", "A result figure or table is present",
          "結果節に関連付けられた図表を確認しました。", "A figure or table linked to a result section was found.",
          "本文中の説明、図表番号、単位、条件が一致しているか最終確認してください。",
          "Verify that the prose, numbering, units, and conditions agree with the visual.",
          resultsTarget, "登録済みの結果図表", "Existing result visual", resultVisuals.map(function (asset) { return asset.name; }),
        );
      }
    }

    if (claims.length && experimentLike) {
      if (!hasTrialCount) {
        add(
          "numeric.trial-count", "missing", "data",
          "数値結果の試行回数が不足しています", "Trial count is missing for numeric results",
          "試行回数や標本数がないと、数値が単発の観測か反復結果かを判断できません。",
          "Without a trial or sample count, readers cannot tell whether the number is a single observation or a repeated result.",
          "総試行数、除外数、独立な反復単位を、確認できる範囲で記録してください。",
          "Record the total trials, exclusions, and independent unit of replication using verified information.",
          resultsTarget, "n、試行数、標本数を含む条件表または本文", "Condition table or prose stating n, trials, or sample size", claims,
        );
      }
      if (!hasVariability) {
        add(
          "numeric.variability", "recommended", "data",
          "数値結果のばらつきを示す", "Report variability for numeric results",
          "代表値だけでは結果の安定性や分布を評価できません。",
          "A point estimate alone does not show stability or distribution.",
          "実際に算出した場合に限り、標準偏差、四分位範囲、信頼区間、範囲などを追加してください。",
          "If actually calculated, add standard deviation, IQR, confidence intervals, ranges, or another appropriate measure.",
          resultsTarget, "平均±標準偏差、中央値[IQR]、信頼区間、誤差棒", "Mean ± SD, median [IQR], confidence interval, or error bars", claims,
        );
      }
      if (!hasComparison) {
        add(
          "numeric.comparison", "recommended", "data",
          "比較対象または基準値を明示する", "State a comparator or reference value",
          "比較対象がないため、得られた数値の相対的な意味を判断しにくい状態です。",
          "Without a comparator, the relative meaning of the reported number is difficult to assess.",
          "比較を実施した場合に限り、基準手法、対照条件、目標値と選定理由を追加してください。",
          "Only if a comparison was performed, add the baseline, control, target value, and rationale.",
          resultsTarget, "同一条件の比較表または差分グラフ", "Matched comparison table or difference plot", claims,
        );
      }
    }

    if (claims.length) {
      if (!hasTraceableSource) {
        add(
          "numeric.traceability", "missing", "provenance",
          "数値の根拠を追跡できません", "The source of numeric claims is not traceable",
          "数値に対応する原データ、データ公開情報、または引用が見つからず、根拠を確認できません。",
          "No linked source data, data-availability statement, or citation was found for the numeric claims.",
          "自ら取得した値なら原データと取得条件を、外部の値なら確認済み文献の引用を関連付けてください。",
          "Link source data and acquisition conditions for original results, or a verified citation for external values.",
          resultsTarget, "CSV等の原データ＋取得条件、または引用キー", "Source data such as CSV plus conditions, or a citation key", claims,
        );
      }
      if ((!experimentLike || (hasTrialCount && hasVariability && hasComparison)) && hasTraceableSource) {
        add(
          "numeric.support", "ok", "data",
          "数値結果の主要な裏付けを確認しました", "Core support for numeric results was found",
          "このルールで確認する試行・ばらつき・比較・追跡情報が揃っています。",
          "The trial, uncertainty, comparison, and traceability checks applicable to this project passed.",
          "数値、単位、図表、原データ間の一致を最終確認してください。",
          "Perform a final consistency check across values, units, visuals, and source data.",
          resultsTarget, "登録済みの証拠資料", "Existing evidence", claims,
        );
      }
    }

    if (methodText && !projectIsReview) {
      if (!methodDiagrams.length) {
        add(
          "method.diagram", "recommended", "presentation",
          projectIsProposal ? "提案手法の流れを図示する" : "手法またはシステム構成を図示する",
          projectIsProposal ? "Diagram the proposed workflow" : "Diagram the method or system architecture",
          "構成要素と処理順序の関係が文章だけでは把握しにくいためです。",
          "Relationships among components and processing steps are difficult to understand from prose alone.",
          "本文に記録済みの要素だけを使い、入力、主要処理、出力、境界を図示してください。",
          "Use only recorded information to diagram inputs, major processing steps, outputs, and boundaries.",
          methodTarget, "構成図、ブロック図、処理フロー、実験系の模式図", "Architecture, block diagram, workflow, or setup schematic", [excerpt(methodText, limits)],
        );
      } else {
        add(
          "method.diagram", "ok", "presentation",
          "手法を説明する構成図があります", "A method or architecture diagram is present",
          "手法節に関連付けられた構成図を確認しました。", "A diagram linked to a method section was found.",
          "本文中の名称と図中の名称が一致しているか確認してください。",
          "Verify that names in the figure match those in the manuscript.",
          methodTarget, "登録済みの構成図", "Existing method diagram", methodDiagrams.map(function (asset) { return asset.name; }),
        );
      }
    }

    var assetIssues = 0;
    assets.forEach(function (asset) {
      var target = sectionById[asset.target] || { id: "assets", title: "" };
      if (!asset.hasPayload) {
        assetIssues += 1;
        add(
          "asset." + asset.index + ".payload", "missing", "asset-payload",
          "添付ファイルの再添付が必要です", "The attachment must be reattached",
          "「" + asset.name + "」の登録情報は残っていますが、ファイル本体を確認できません。localStorage または JSON から復元した場合に起こることがあります。",
          'Metadata for "' + asset.name + '" remains, but its file payload is unavailable. This can happen after restoring from localStorage or JSON.',
          "元のファイルを再添付するか、添付本体を含む ZIP バックアップから復元してください。",
          "Reattach the original file or restore it from a ZIP backup that includes attachment payloads.",
          target, "元の添付ファイルまたは添付入り ZIP", "Original file or ZIP backup with attachments", [asset.name], asset.id,
        );
      }
      if (!asset.target || !sectionById[asset.target] || sectionKind(sectionById[asset.target]) === "references") {
        assetIssues += 1;
        add(
          "asset." + asset.index + ".target", "missing", "asset-metadata",
          "図・データの対象節が不足しています", "The asset has no valid target section",
          "「" + asset.name + "」の使用場所が未指定、削除済み、または参考文献節になっています。",
          'The use location for "' + asset.name + '" is missing, deleted, or points to references.',
          "本文中で実際に説明する節を選択してください。",
          "Select the manuscript section where the asset is actually discussed.",
          target, "有効な本文節への関連付け", "Link to a valid body section", [asset.name], asset.id,
        );
      }
      if ((isVisual(asset) || isDataAsset(asset)) && !asset.caption) {
        assetIssues += 1;
        add(
          "asset." + asset.index + ".caption", isVisual(asset) ? "missing" : "recommended", "asset-metadata",
          "図・データの説明が不足しています", "The asset needs a caption or description",
          "「" + asset.name + "」だけでは内容、条件、単位を判断できません。",
          'The name "' + asset.name + '" does not explain its content, conditions, or units.',
          "何を示すか、条件、単位、略語を、確認済み情報だけで記述してください。",
          "Describe what it shows, its conditions, units, and abbreviations using verified information only.",
          target, isVisual(asset) ? "自己完結したキャプション" : "データ内容・列・単位の説明", isVisual(asset) ? "Self-contained caption" : "Description of data, columns, and units", [asset.name], asset.id,
        );
      }
      if (asset.origin === "cited" && !asset.source) {
        assetIssues += 1;
        add(
          "asset." + asset.index + ".source", "missing", "asset-metadata",
          "引用図表の出典が不足しています", "The cited asset has no source",
          "「" + asset.name + "」は引用・転載として登録されていますが、出典を確認できません。",
          '"' + asset.name + '" is marked as cited or reused, but no source is recorded.',
          "原典、該当箇所、ライセンスまたは転載条件を確認して記録してください。",
          "Verify and record the original source, relevant location, and license or reuse terms.",
          target, "引用キー、DOI/URL、ライセンス情報", "Citation key, DOI/URL, and license information", [asset.name], asset.id,
        );
      } else if (isVisual(asset) && asset.origin === "unknown" && !asset.source) {
        assetIssues += 1;
        add(
          "asset." + asset.index + ".origin", "recommended", "asset-metadata",
          "図表の由来を確認する", "Confirm the origin of the visual",
          "「" + asset.name + "」が自作か引用か判定できず、出典要否を確認できません。",
          'It is unclear whether "' + asset.name + '" is original or cited, so source requirements cannot be checked.',
          "自作・引用を選び、引用なら確認済みの出典を追加してください。",
          "Mark it as original or cited; if cited, add the verified source.",
          target, "由来区分と、必要な場合は引用情報", "Origin classification and citation where required", [asset.name], asset.id,
        );
      }
    });
    if (assets.length && !assetIssues) {
      add(
        "assets.metadata", "ok", "asset-metadata",
        "図・データの基本情報が揃っています", "Asset metadata is complete",
        "対象節、説明、必要な出典を確認しました。", "Targets, descriptions, and required sources were found.",
        "本文から各資料が参照されているか最終確認してください。",
        "Verify that every asset is referenced from the manuscript.",
        { id: "assets", title: "" }, "登録済みメタデータ", "Existing metadata", assets.map(function (asset) { return asset.name; }),
      );
    }

    if (projectIsReview) {
      var reviewTable = assets.some(function (asset) {
        return asset.hasPayload && asset.role === "table" && (assetTargetsKind(asset, "review", sectionById) || assetTargetsKind(asset, "results", sectionById));
      });
      if (!reviewTable) {
        add(
          "type.review.comparison-table", "recommended", "project-type",
          "文献の比較・分類表を追加する", "Add a literature comparison or classification table",
          "レビューでは、各文献の条件と差異を同じ軸で追跡できることが重要です。",
          "A review should make conditions and differences across sources traceable on consistent dimensions.",
          "確認済み文献だけを使い、選定基準、対象、手法、主要結果、限界を整理してください。",
          "Using verified sources only, organize selection criteria, scope, methods, main findings, and limitations.",
          reviewTarget, "文献比較表またはエビデンスマトリクス", "Literature comparison table or evidence matrix", [],
        );
      }
    }

    if (projectIsProposal) {
      var planVisual = assets.some(function (asset) {
        return asset.hasPayload && isVisual(asset) && assetTargetsKind(asset, "plan", sectionById);
      });
      if (!planVisual) {
        add(
          "type.proposal.timeline", "recommended", "project-type",
          "研究計画を時系列で示す", "Show the research plan over time",
          "課題、成果物、依存関係を時系列で示すと、計画の実行可能性を確認しやすくなります。",
          "A timeline makes tasks, deliverables, dependencies, and feasibility easier to assess.",
          "入力済みの計画と日程だけを使い、作業、成果物、判断点を配置してください。",
          "Use only the entered plan and schedule to place tasks, deliverables, and decision points.",
          planTarget, "工程表、ガントチャート、マイルストーン表", "Timeline, Gantt chart, or milestone table", [readField(source, "researchPlan"), readField(source, "schedule")],
        );
      }
    }

    if (/robot/.test(templateId + " " + documentType)) {
      var setupVisual = assets.some(function (asset) {
        return asset.hasPayload && isVisual(asset) && /setup|apparatus|environment|配置|実験環境|装置/.test(lower(asset.name + " " + asset.caption, 2600));
      });
      if (!setupVisual) {
        add(
          "type.robotics.setup", "recommended", "project-type",
          "ロボット実験の配置と環境を示す", "Show the robotic experiment setup and environment",
          "ロボット、センサ、対象物、座標系の配置は結果の再現性に影響します。",
          "The arrangement of the robot, sensors, objects, and coordinate frames affects reproducibility.",
          "記録済みの寸法と配置だけを用い、座標系、主要機器、計測範囲を示してください。",
          "Use only recorded dimensions and placements to show coordinate frames, main equipment, and measurement range.",
          methodTarget, "実験配置図、写真＋注釈、座標系模式図", "Setup diagram, annotated photograph, or coordinate-frame schematic", [],
        );
      }
    }

    if (/experiment-report|laboratory-report/.test(templateId + " " + documentType) && !resultData.length && resultsText) {
      add(
        "type.experiment-report.raw-data", "recommended", "project-type",
        "集計前の結果データを関連付ける", "Link the pre-aggregation result data",
        "集計値だけでは計算過程や転記誤りを後から検証できません。",
        "Aggregates alone do not allow later verification of calculations or transcription errors.",
        "保存可能な範囲で、測定行、列名、単位、欠測値の扱いを記録してください。",
        "Where possible, record measurement rows, column names, units, and missing-value handling.",
        resultsTarget, "CSVまたは表形式データ＋データ辞書", "CSV or tabular data plus a data dictionary", [],
      );
    }

    var counts = { missing: 0, recommended: 0, ok: 0 };
    findings.forEach(function (finding) {
      counts[finding.status] += 1;
    });
    return {
      version: 1,
      status: counts.missing ? "missing" : counts.recommended ? "recommended" : "ok",
      summary: {
        missing: counts.missing,
        recommended: counts.recommended,
        ok: counts.ok,
        total: findings.length,
      },
      findings: findings,
      inspected: {
        sections: sections.length,
        assets: assets.length,
        numericClaims: claims.length,
        references: references.length,
      },
      truncated: {
        sections: Array.isArray(source.manuscript && source.manuscript.sections) && source.manuscript.sections.length > limits.maxSections,
        assets: Array.isArray(source.assets) && source.assets.length > limits.maxAssets,
        findings: omittedFindings > 0,
        omittedFindings: omittedFindings,
      },
    };
  }

  return {
    EVIDENCE_AUDIT_LIMITS: DEFAULT_LIMITS,
    auditEvidence: auditEvidence,
    analyzeEvidence: auditEvidence,
  };
});
