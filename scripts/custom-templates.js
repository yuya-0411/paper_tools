(function (root, factory) {
  "use strict";

  var api = factory();
  var namespace = root.PaperTools || (root.PaperTools = {});

  namespace.customTemplates = api;
  namespace.analyzeCustomTemplate = api.analyzeCustomTemplate;
  namespace.analyzeCustomTemplateFile = api.analyzeCustomTemplateFile;
  namespace.validateCustomTemplateDefinition = api.validateTemplateDefinition;

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LIMITS = Object.freeze({
    maxSourceBytes: 512 * 1024,
    maxSourceCharacters: 500000,
    maxSections: 48,
    maxSectionTitle: 160,
    maxTemplateName: 120,
    maxDescription: 500,
    maxRequiredInputs: 24,
    maxFilename: 220,
  });

  var SUPPORTED_FORMATS = Object.freeze([
    "json",
    "markdown",
    "text",
    "typst",
    "latex",
    "html",
  ]);

  var FORMAT_BY_EXTENSION = Object.freeze({
    json: "json",
    md: "markdown",
    markdown: "markdown",
    txt: "text",
    text: "text",
    typ: "typst",
    typst: "typst",
    tex: "latex",
    latex: "latex",
    html: "html",
    htm: "html",
    pdf: "pdf",
    docx: "docx",
  });

  var ALLOWED_REQUIRED_INPUTS = Object.freeze([
    "title",
    "objective",
    "background",
    "novelty",
    "method",
    "results",
    "discussion",
    "conclusion",
    "comparison",
    "limitations",
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
    "references",
  ]);

  var REQUIRED_INPUT_ALIASES = Object.freeze({
    title: "title",
    objective: "objective",
    objectives: "objective",
    purpose: "objective",
    background: "background",
    novelty: "novelty",
    method: "method",
    methods: "method",
    methodology: "method",
    experiment: "experimentalConditions",
    experiments: "experimentalConditions",
    experimentalconditions: "experimentalConditions",
    experimentalsetup: "experimentalConditions",
    results: "results",
    discussion: "discussion",
    conclusion: "conclusion",
    comparison: "comparison",
    limitations: "limitations",
    problem: "problem",
    systemdesign: "systemDesign",
    metrics: "metrics",
    evaluationmetrics: "metrics",
    searchstrategy: "searchStrategy",
    classification: "classification",
    researchgaps: "researchGaps",
    researchplan: "researchPlan",
    expectedresults: "expectedResults",
    schedule: "schedule",
    equipment: "equipment",
    futurework: "futureWork",
    dataavailability: "dataAvailability",
    ethics: "ethics",
    references: "references",
    bibliography: "references",
  });

  var SEMANTICS = [
    semantic("abstract", "概要", "Abstract", /^(abstract|summary|executive summary|概要|要旨|抄録|要約)$/i, []),
    semantic("introduction", "はじめに", "Introduction", /^(introduction|intro|はじめに|序論|緒言)$/i, ["background", "objective"]),
    semantic("related-work", "関連研究", "Related Work", /^(related work|previous work|prior work|literature review|関連研究|先行研究|従来研究|文献レビュー)$/i, ["comparison", "references"]),
    semantic("system-design", "システム設計", "System Design", /^(system (design|architecture)|architecture|robot and system design|システム設計|システム構成|装置構成)$/i, ["systemDesign"]),
    semantic("experimental-setup", "実験条件", "Experimental Setup", /^(experimental (setup|conditions?|procedure)|experiment(al)? design|test setup|実験条件|実験設定|実験方法|評価条件)$/i, ["experimentalConditions"]),
    semantic("evaluation-metrics", "評価指標", "Evaluation Metrics", /^(evaluation metrics?|metrics?|evaluation criteria|評価指標|評価尺度|評価基準)$/i, ["metrics"]),
    semantic("search-strategy", "検索戦略", "Search Strategy", /^(search strategy|search method|検索戦略|検索方法)$/i, ["searchStrategy", "references"]),
    semantic("research-plan", "研究計画", "Research Plan", /^(research plan|work plan|研究計画|実施計画)$/i, ["researchPlan"]),
    semantic("expected-results", "期待される結果", "Expected Results", /^(expected results?|anticipated results?|期待される結果|予想結果)$/i, ["expectedResults"]),
    semantic("results-discussion", "結果と考察", "Results and Discussion", /^(results? and discussion|results? & discussion|結果と考察|結果\s*[&＆・]\s*考察)$/i, ["results", "discussion"]),
    semantic("background", "背景", "Background", /^(background|research context|背景|研究背景)$/i, ["background"]),
    semantic("problem", "研究課題", "Problem", /^(problem|problem statement|research question|課題|研究課題|問題設定|研究質問)$/i, ["problem"]),
    semantic("objective", "研究目的", "Objective", /^(objectives?|aims?|purpose|research purpose|目的|研究目的)$/i, ["objective"]),
    semantic("method", "手法", "Method", /^(methods?|methodology|materials and methods|proposed (method|approach)|approach|procedure|手法|方法|提案手法|研究方法|材料と方法|手順)$/i, ["method"]),
    semantic("experiments", "実験", "Experiments", /^(experiments?|tests?|実験|検証実験)$/i, ["experimentalConditions"]),
    semantic("evaluation", "評価", "Evaluation", /^(evaluation|validation|assessment|評価|検証)$/i, ["metrics", "results"]),
    semantic("results", "結果", "Results", /^(results?|findings?|outcomes?|結果|実験結果)$/i, ["results"]),
    semantic("discussion", "考察", "Discussion", /^(discussion|analysis|考察|分析)$/i, ["discussion"]),
    semantic("comparison", "比較", "Comparison", /^(comparison|comparative analysis|比較|比較分析)$/i, ["comparison"]),
    semantic("limitations", "限界", "Limitations", /^(limitations?|threats to validity|constraints|限界|制約|妥当性への脅威)$/i, ["limitations"]),
    semantic("classification", "分類", "Classification", /^(classification|taxonomy|categorization|分類|体系化)$/i, ["classification"]),
    semantic("research-gaps", "研究ギャップ", "Research Gaps", /^(research gaps?|open issues?|研究ギャップ|未解決課題)$/i, ["researchGaps"]),
    semantic("equipment", "使用機器", "Equipment", /^(equipment|apparatus|materials|使用機器|実験装置|機材)$/i, ["equipment"]),
    semantic("schedule", "スケジュール", "Schedule", /^(schedule|timeline|スケジュール|工程)$/i, ["schedule"]),
    semantic("data-availability", "データ公開", "Data Availability", /^(data availability|availability of data|データ公開|データ可用性)$/i, ["dataAvailability"]),
    semantic("ethics", "倫理的配慮", "Ethics", /^(ethics|ethical considerations?|倫理|倫理的配慮)$/i, ["ethics"]),
    semantic("future-work", "今後の課題", "Future Work", /^(future work|future directions?|今後の課題|今後の展望)$/i, ["futureWork"]),
    semantic("conclusion", "結論", "Conclusion", /^(conclusions?|concluding remarks|まとめ|結論|おわりに)$/i, ["conclusion"]),
    semantic("acknowledgements", "謝辞", "Acknowledgements", /^(acknowledg(e)?ments?|謝辞)$/i, []),
    semantic("references", "参考文献", "References", /^(references|bibliography|works cited|参考文献|引用文献)$/i, ["references"]),
  ];

  function semantic(id, ja, en, pattern, requiredInputs) {
    return { id: id, ja: ja, en: en, pattern: pattern, requiredInputs: requiredInputs };
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(Object(object), key);
  }

  function utf8ByteLength(value) {
    var text = String(value == null ? "" : value);
    var bytes = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function decodeHtmlEntities(value) {
    var named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
      nbsp: " ",
      ndash: "–",
      mdash: "—",
    };
    return String(value == null ? "" : value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, entity) {
      var lower = entity.toLowerCase();
      if (own(named, lower)) return named[lower];
      var code = lower.indexOf("#x") === 0
        ? parseInt(lower.slice(2), 16)
        : lower.charAt(0) === "#" ? parseInt(lower.slice(1), 10) : NaN;
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      try {
        return String.fromCodePoint(code);
      } catch (_error) {
        return "";
      }
    });
  }

  function stripDangerousHtmlBlocks(value) {
    return String(value == null ? "" : value)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  }

  function sanitizeTemplateText(value, maxLength) {
    var limit = Number.isFinite(maxLength) ? Math.max(0, maxLength) : LIMITS.maxDescription;
    var text = String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
    text = decodeHtmlEntities(decodeHtmlEntities(stripDangerousHtmlBlocks(text)));
    text = stripDangerousHtmlBlocks(text)
      .replace(/<[^>]*>/g, " ")
      .replace(/[<>]/g, "")
      .replace(/[\t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (typeof text.normalize === "function") text = text.normalize("NFC");
    return text.slice(0, limit).trim();
  }

  function cleanFilename(value) {
    return sanitizeTemplateText(value, LIMITS.maxFilename)
      .replace(/[\\/:*?"|]/g, "-")
      .replace(/\.\.+/g, ".")
      .replace(/^\.+|[. ]+$/g, "") || "template.txt";
  }

  function extensionOf(filename) {
    if (!String(filename == null ? "" : filename).trim()) return "";
    var match = cleanFilename(filename).toLowerCase().match(/\.([a-z0-9]{1,12})$/);
    return match ? match[1] : "";
  }

  function formatFromMime(mime) {
    var value = String(mime || "").toLowerCase().split(";")[0].trim();
    if (value === "application/pdf") return "pdf";
    if (value === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
    if (value === "application/json" || value === "text/json") return "json";
    if (value === "text/markdown") return "markdown";
    if (value === "text/html") return "html";
    if (value === "text/x-tex" || value === "application/x-tex") return "latex";
    if (value === "text/plain") return "text";
    return "";
  }

  function sniffFormat(text) {
    var source = String(text || "").replace(/^\ufeff/, "").trimStart();
    if (/^%PDF-/i.test(source)) return "pdf";
    if (/^[\[{]/.test(source)) {
      try {
        JSON.parse(source);
        return "json";
      } catch (_error) {
        // Continue with text-oriented detection.
      }
    }
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(source) || /<h[1-6]\b/i.test(source)) return "html";
    if (/\\documentclass\b|\\(?:sub)*section\*?\s*\{/i.test(source)) return "latex";
    if (/^\s*#(?:set|show|let)\b/m.test(source) || /^\s*=+\s+\S/m.test(source)) return "typst";
    if (/^\s{0,3}#{1,6}\s+\S/m.test(source) || /^\s*(?:---|```)/m.test(source)) return "markdown";
    return "text";
  }

  function sniffBinaryFormat(text) {
    var source = String(text || "").replace(/^\ufeff/, "");
    if (/^%PDF-/i.test(source)) return "pdf";
    if (/^PK\u0003\u0004/.test(source)) return "docx";
    return "";
  }

  function detectFormat(filename, mime, text, requestedFormat) {
    var extension = extensionOf(filename);
    var extensionFormat = own(FORMAT_BY_EXTENSION, extension) ? FORMAT_BY_EXTENSION[extension] : "";
    var mimeFormat = formatFromMime(mime);
    if (extensionFormat === "pdf" || extensionFormat === "docx") return extensionFormat;
    if (mimeFormat === "pdf" || mimeFormat === "docx") return mimeFormat;

    var requested = String(requestedFormat || "").toLowerCase().trim();
    if (requested === "md") requested = "markdown";
    if (requested === "txt") requested = "text";
    if (requested === "tex") requested = "latex";
    if (requested === "typ") requested = "typst";
    if (requested === "htm") requested = "html";
    if (SUPPORTED_FORMATS.indexOf(requested) >= 0 || requested === "pdf" || requested === "docx") return requested;

    if (extensionFormat) return extensionFormat;
    if (extension) return "unknown";
    if (mimeFormat) return mimeFormat;
    return sniffFormat(text);
  }

  function failure(code, message, extra) {
    var result = {
      ok: false,
      unsupported: code === "unsupported-binary-format" || code === "unsupported-format" || code === "binary-input",
      code: code,
      message: message,
    };
    Object.keys(extra || {}).forEach(function (key) {
      result[key] = extra[key];
    });
    return result;
  }

  function stripHeadingNumber(value) {
    return String(value || "")
      .replace(/^\s*(?:第\s*[0-9０-９一二三四五六七八九十百]+\s*[章節部編]\s*)/u, "")
      .replace(/^\s*(?:[0-9０-９]+(?:\s*[.．]\s*[0-9０-９]+)*\s*[.)．、:]?\s+)/u, "")
      .replace(/^\s*(?:[IVXLCDM]+\s*[.)]\s+)/i, "")
      .trim();
  }

  function cleanMarkdownTitle(value) {
    var text = String(value || "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/[*_~]+/g, "")
      .replace(/\s+#+\s*$/, "");
    return sanitizeTemplateText(text, LIMITS.maxSectionTitle);
  }

  function cleanLatexTitle(value) {
    var text = String(value || "")
      .replace(/\\label\s*\{[^{}]*\}/g, "")
      .replace(/\\(?:textbf|textit|emph|underline|textrm|textsf|texttt)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\(?:&|%|#|_|\$|\{|\})/g, function (match) { return match.slice(1); })
      .replace(/~+/g, " ")
      .replace(/\\[A-Za-z@]+\*?/g, "");
    return sanitizeTemplateText(text, LIMITS.maxSectionTitle);
  }

  function cleanTypstTitle(value) {
    return sanitizeTemplateText(String(value || "")
      .replace(/<[^>\n]+>\s*$/g, "")
      .replace(/[`*_#$]+/g, "")
      .replace(/#(?:strong|emph|text)\s*\[([^\]]*)\]/g, "$1"), LIMITS.maxSectionTitle);
  }

  function normalizeHeadingTitle(value, cleaner) {
    return stripHeadingNumber((cleaner || sanitizeTemplateText)(value, LIMITS.maxSectionTitle));
  }

  function splitDocumentTitle(headings, explicitTitle) {
    var list = headings.filter(function (item) { return item && item.title; });
    if (!list.length) return { title: explicitTitle || "", sections: [] };
    var levelOne = list.filter(function (item) { return item.level === 1; });
    var hasDeeper = list.some(function (item) { return item.level > 1; });
    if (levelOne.length === 1 && hasDeeper) {
      return {
        title: explicitTitle || levelOne[0].title,
        sections: list.filter(function (item) { return item !== levelOne[0]; }),
      };
    }
    return { title: explicitTitle || "", sections: list };
  }

  function selectTopLevelSections(sections) {
    if (!sections.length) return [];
    var minimum = sections.reduce(function (current, item) {
      var level = Number(item.level) || 1;
      return Math.min(current, level);
    }, Number.POSITIVE_INFINITY);
    return sections.filter(function (item) { return (Number(item.level) || 1) === minimum; });
  }

  function parseMarkdownFrontMatter(source) {
    var result = { body: source, metadata: {} };
    if (!/^---\s*\n/.test(source)) return result;
    var end = source.indexOf("\n---", 4);
    if (end < 0 || end > 10000) return result;
    source.slice(4, end).split(/\n/).forEach(function (line) {
      var match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
      if (match) result.metadata[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, "");
    });
    result.body = source.slice(end + 4).replace(/^\s*\n/, "");
    return result;
  }

  function extractMarkdown(source) {
    var frontMatter = parseMarkdownFrontMatter(source);
    var lines = frontMatter.body.split(/\n/);
    var headings = [];
    var inFence = false;
    var fenceCharacter = "";
    for (var i = 0; i < lines.length; i += 1) {
      var fence = lines[i].match(/^\s*(```+|~~~+)/);
      if (fence) {
        var marker = fence[1].charAt(0);
        if (!inFence) {
          inFence = true;
          fenceCharacter = marker;
        } else if (marker === fenceCharacter) {
          inFence = false;
          fenceCharacter = "";
        }
        continue;
      }
      if (inFence) continue;
      var atx = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
      if (atx) {
        headings.push({ level: atx[1].length, title: normalizeHeadingTitle(atx[2], cleanMarkdownTitle) });
        continue;
      }
      if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && lines[i].trim()) {
        headings.push({ level: lines[i + 1].trim().charAt(0) === "=" ? 1 : 2, title: normalizeHeadingTitle(lines[i], cleanMarkdownTitle) });
        i += 1;
      }
      if (headings.length > LIMITS.maxSections + 2) break;
    }
    var title = frontMatter.metadata.title ? sanitizeTemplateText(frontMatter.metadata.title, LIMITS.maxTemplateName) : "";
    var split = splitDocumentTitle(headings, title);
    var language = frontMatter.metadata.lang || frontMatter.metadata.language || "";
    var columns = frontMatter.metadata.columns || frontMatter.metadata.layout || frontMatter.metadata.twocolumn || "";
    return {
      title: split.title,
      sections: split.sections,
      language: language,
      twoColumn: /^(?:2|true|two[- ]?column|2段組|二段組)$/i.test(columns) || /(?:^|\n)\s*(?:layout|columns?)\s*:\s*(?:two[- ]?column|2)\s*(?:\n|$)/i.test(source),
      requiredInputs: parseDelimitedRequiredInputs(frontMatter.metadata.requiredinputs || frontMatter.metadata.required || ""),
    };
  }

  function stripLatexComments(source) {
    return source.split(/\n/).map(function (line) {
      for (var i = 0; i < line.length; i += 1) {
        if (line.charAt(i) === "%" && (i === 0 || line.charAt(i - 1) !== "\\")) return line.slice(0, i);
      }
      return line;
    }).join("\n");
  }

  function extractBalancedBrace(source, openingIndex) {
    if (source.charAt(openingIndex) !== "{") return null;
    var depth = 0;
    for (var i = openingIndex; i < source.length; i += 1) {
      var character = source.charAt(i);
      if (character === "\\") {
        i += 1;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return { content: source.slice(openingIndex + 1, i), end: i + 1 };
      }
    }
    return null;
  }

  function extractLatexCommands(source, commandPattern, level) {
    var results = [];
    var matcher = new RegExp("\\\\(" + commandPattern + ")\\*?\\s*\\{", "gi");
    var match;
    while ((match = matcher.exec(source)) && results.length <= LIMITS.maxSections + 1) {
      var opening = matcher.lastIndex - 1;
      var balanced = extractBalancedBrace(source, opening);
      if (!balanced) continue;
      var title = normalizeHeadingTitle(balanced.content, cleanLatexTitle);
      if (title) results.push({ level: typeof level === "function" ? level(match[1]) : level, title: title });
      matcher.lastIndex = balanced.end;
    }
    return results;
  }

  function extractLatex(source) {
    var clean = stripLatexComments(source);
    var headings = extractLatexCommands(clean, "section|subsection|subsubsection", function (command) {
      return command.toLowerCase() === "section" ? 1 : command.toLowerCase() === "subsection" ? 2 : 3;
    });
    var titleCommands = extractLatexCommands(clean, "title", 1);
    var language = /\\usepackage(?:\[[^\]]*\])?\{(?:luatexja|pxchfon|zxjatype|japanese)\}|\\documentclass(?:\[[^\]]*\])?\{(?:jsarticle|jsbook|jreport|jlreq)\}/i.test(clean)
      ? "ja"
      : /\\usepackage\[(british|american|english)\]\{babel\}/i.test(clean) ? "en" : "";
    return {
      title: titleCommands[0] ? titleCommands[0].title : "",
      sections: headings,
      language: language,
      twoColumn: /\\documentclass\s*\[[^\]]*\btwocolumn\b[^\]]*\]|\\twocolumn\b|\\begin\s*\{multicols\}\s*\{\s*2\s*\}/i.test(clean),
      requiredInputs: [],
    };
  }

  function extractTypst(source) {
    var clean = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
    var headings = [];
    clean.split(/\n/).forEach(function (line) {
      if (headings.length > LIMITS.maxSections + 1) return;
      var match = line.match(/^\s*(={1,6})\s+(.+?)\s*$/);
      if (match) headings.push({ level: match[1].length, title: normalizeHeadingTitle(match[2], cleanTypstTitle) });
    });
    var headingCall = /#heading\s*\(([^)]*)\)\s*\[([^\]]+)\]/gi;
    var call;
    while ((call = headingCall.exec(clean)) && headings.length <= LIMITS.maxSections + 1) {
      var levelMatch = call[1].match(/level\s*:\s*([1-6])/i);
      headings.push({ level: levelMatch ? Number(levelMatch[1]) : 1, title: normalizeHeadingTitle(call[2], cleanTypstTitle) });
    }
    headings.sort(function (left, right) {
      return clean.indexOf(left.title) - clean.indexOf(right.title);
    });
    var titleMatch = clean.match(/#set\s+document\s*\([^)]*\btitle\s*:\s*(?:\[([^\]]+)\]|"([^"]+)")/i);
    var languageMatch = clean.match(/#set\s+text\s*\([^)]*\blang\s*:\s*"(ja|en)(?:-[A-Za-z]+)?"/i);
    var split = splitDocumentTitle(headings, titleMatch ? cleanTypstTitle(titleMatch[1] || titleMatch[2]) : "");
    return {
      title: split.title,
      sections: split.sections,
      language: languageMatch ? languageMatch[1].toLowerCase() : "",
      twoColumn: /\bcolumns?\s*:\s*2\b|#columns\s*\(\s*2\s*\)|#show\s*:\s*columns\.with\s*\(\s*2\s*\)/i.test(clean),
      requiredInputs: [],
    };
  }

  function extractHtml(source) {
    var clean = stripDangerousHtmlBlocks(source);
    var titleMatch = clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    var htmlLanguage = clean.match(/<html\b[^>]*\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    var headings = [];
    var matcher = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    var match;
    while ((match = matcher.exec(clean)) && headings.length <= LIMITS.maxSections + 1) {
      var title = normalizeHeadingTitle(match[2], sanitizeTemplateText);
      if (title) headings.push({ level: Number(match[1]), title: title });
    }
    var split = splitDocumentTitle(headings, titleMatch ? sanitizeTemplateText(titleMatch[1], LIMITS.maxTemplateName) : "");
    return {
      title: split.title,
      sections: split.sections,
      language: htmlLanguage ? (htmlLanguage[1] || htmlLanguage[2] || htmlLanguage[3]) : "",
      twoColumn: /(?:column-count|-webkit-column-count)\s*:\s*2\b|data-(?:layout|columns)\s*=\s*["'](?:two-column|2)["']/i.test(clean),
      requiredInputs: [],
    };
  }

  function normalizeJsonSection(value, level) {
    if (typeof value === "string" || typeof value === "number") {
      return { level: level, title: sanitizeTemplateText(value, LIMITS.maxSectionTitle), id: "" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    var title = own(value, "title") ? value.title
      : own(value, "heading") ? value.heading
        : own(value, "name") ? value.name
          : own(value, "label") ? value.label : "";
    return {
      level: level,
      title: sanitizeTemplateText(title, LIMITS.maxSectionTitle),
      id: sanitizeId(value.id || "", ""),
      requiredInputs: Array.isArray(value.requiredInputs) ? value.requiredInputs : [],
    };
  }

  function collectJsonSections(array, level, output) {
    if (!Array.isArray(array) || level > 6) return;
    for (var i = 0; i < array.length && output.length <= LIMITS.maxSections + 1; i += 1) {
      var item = normalizeJsonSection(array[i], level);
      if (item && item.title) output.push(item);
      if (array[i] && typeof array[i] === "object") {
        var children = array[i].children || array[i].subsections || array[i].sections;
        if (Array.isArray(children)) collectJsonSections(children, level + 1, output);
      }
    }
  }

  function firstOwnValue(object, keys) {
    if (!object || typeof object !== "object") return undefined;
    for (var i = 0; i < keys.length; i += 1) {
      if (own(object, keys[i])) return object[keys[i]];
    }
    return undefined;
  }

  function extractJson(source) {
    var parsed = JSON.parse(source.replace(/^\ufeff/, ""));
    var container = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.template && typeof parsed.template === "object"
      ? parsed.template
      : parsed;
    var sectionSource = Array.isArray(container)
      ? container
      : firstOwnValue(container, ["sections", "headings", "outline", "structure"]);
    var sections = [];
    collectJsonSections(sectionSource, 1, sections);
    var layout = firstOwnValue(container, ["layout", "columns", "columnCount", "twoColumn"]);
    var twoColumn = layout === true || layout === 2 || /^(?:2|true|two[- ]?column|2段組|二段組)$/i.test(String(layout || ""));
    return {
      title: sanitizeTemplateText(firstOwnValue(container, ["name", "templateName", "title"]) || "", LIMITS.maxTemplateName),
      description: sanitizeTemplateText(firstOwnValue(container, ["description", "summary"]) || "", LIMITS.maxDescription),
      type: sanitizeId(firstOwnValue(container, ["type", "documentType"]) || "", "custom-paper"),
      sections: sections,
      language: firstOwnValue(container, ["language", "lang"]) || "",
      twoColumn: twoColumn,
      requiredInputs: firstOwnValue(container, ["requiredInputs", "required", "inputs"]) || [],
    };
  }

  function semanticForTitle(value) {
    var title = stripHeadingNumber(sanitizeTemplateText(value, LIMITS.maxSectionTitle));
    for (var i = 0; i < SEMANTICS.length; i += 1) {
      if (SEMANTICS[i].pattern.test(title)) return SEMANTICS[i];
    }
    return null;
  }

  function looksLikePlainHeading(line) {
    var text = stripHeadingNumber(sanitizeTemplateText(line, LIMITS.maxSectionTitle));
    if (!text || text.length > LIMITS.maxSectionTitle) return false;
    if (semanticForTitle(text)) return true;
    if (/^\s*(?:第\s*[0-9０-９一二三四五六七八九十百]+\s*[章節部編]|[0-9０-９]+(?:\s*[.．]\s*[0-9０-９]+)*\s*[.)．、])\s*\S+/u.test(line)) return true;
    if (/^\s*\[[^\]\n]{1,100}\]\s*$/.test(line)) return true;
    if (/^[A-Z][A-Z0-9 \-&/:]{2,80}$/.test(text)) return true;
    if (/^[^。！？.!?]{1,80}[:：]\s*$/.test(line)) return true;
    return false;
  }

  function extractText(source) {
    var lines = source.split(/\n/);
    var sections = [];
    var title = "";
    var language = "";
    var explicitTwoColumn = false;
    for (var i = 0; i < lines.length && sections.length <= LIMITS.maxSections + 1; i += 1) {
      var raw = lines[i].trim();
      if (!raw) continue;
      var metadata = raw.match(/^(title|template|language|lang|layout|columns?)\s*[:：]\s*(.+)$/i);
      if (metadata) {
        var key = metadata[1].toLowerCase();
        if (key === "title" || key === "template") title = sanitizeTemplateText(metadata[2], LIMITS.maxTemplateName);
        if (key === "language" || key === "lang") language = metadata[2];
        if (key === "layout" || key.indexOf("column") === 0) explicitTwoColumn = /(?:two[- ]?column|2|2段組|二段組)/i.test(metadata[2]);
        continue;
      }
      if (!looksLikePlainHeading(raw)) continue;
      var heading = raw.replace(/^\s*\[|\]\s*$/g, "").replace(/[:：]\s*$/, "");
      sections.push({ level: 1, title: normalizeHeadingTitle(heading, sanitizeTemplateText) });
    }
    return {
      title: title,
      sections: sections,
      language: language,
      twoColumn: explicitTwoColumn || /(?:^|\n)\s*(?:two[- ]column|2段組|二段組)\s*(?:\n|$)/i.test(source),
      requiredInputs: [],
    };
  }

  function parseDelimitedRequiredInputs(value) {
    if (Array.isArray(value)) return value.slice();
    if (typeof value !== "string") return [];
    return value.replace(/^\[|\]$/g, "").split(/[,，;\s]+/).filter(Boolean);
  }

  function normalizeLanguage(explicitLanguage, text) {
    var explicit = String(explicitLanguage || "").trim().toLowerCase();
    if (/^(ja|ja-jp|jp|japanese|日本語)$/.test(explicit)) return "ja";
    if (/^(en|en-us|en-gb|english|英語)$/.test(explicit)) return "en";
    var sample = String(text || "");
    var japanese = sample.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || [];
    var latin = sample.match(/[A-Za-z]/g) || [];
    return japanese.length >= 2 && japanese.length * 2 >= latin.length ? "ja" : "en";
  }

  function normalizeRequiredInput(value) {
    var compact = sanitizeTemplateText(value, 80).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    return own(REQUIRED_INPUT_ALIASES, compact) ? REQUIRED_INPUT_ALIASES[compact] : "";
  }

  function sanitizeId(value, fallback) {
    var id = String(value == null ? "" : value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 56);
    if (id && !/^[a-z]/.test(id)) id = "section-" + id;
    if (id === "__proto__" || id === "prototype" || id === "constructor") id = "";
    return id || fallback || "";
  }

  function inferSectionId(title, providedId) {
    var provided = sanitizeId(providedId, "");
    if (provided) return provided;
    var matched = semanticForTitle(title);
    if (matched) return matched.id;
    return sanitizeId(stripHeadingNumber(title), "");
  }

  function fnv1a(value) {
    var hash = 0x811c9dc5;
    var text = String(value || "");
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ("00000000" + hash.toString(16)).slice(-8);
  }

  function filenameStem(filename) {
    var clean = cleanFilename(filename).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    return sanitizeTemplateText(clean, LIMITS.maxTemplateName);
  }

  function defaultSections(language) {
    var definitions = [
      ["abstract", "概要", "Abstract"],
      ["introduction", "はじめに", "Introduction"],
      ["method", "手法", "Method"],
      ["results", "結果", "Results"],
      ["discussion", "考察", "Discussion"],
      ["conclusion", "結論", "Conclusion"],
      ["references", "参考文献", "References"],
    ];
    return definitions.map(function (item) {
      return { level: 1, id: item[0], title: language === "ja" ? item[1] : item[2] };
    });
  }

  function makeUniqueId(base, index, used) {
    var safeBase = sanitizeId(base, "section-" + String(index + 1).padStart(2, "0"));
    var candidate = safeBase;
    var suffix = 2;
    while (own(used, candidate)) {
      candidate = safeBase.slice(0, 48) + "-" + suffix;
      suffix += 1;
    }
    used[candidate] = true;
    return candidate;
  }

  function normalizeSections(rawSections, language, warnings) {
    var selected = selectTopLevelSections(rawSections || []);
    if (selected.length > LIMITS.maxSections) return { error: "too-many-sections" };
    if (!selected.length) {
      warnings.push("見出しを検出できなかったため、標準的な論文構成を使用しました。");
      selected = defaultSections(language);
    }
    var usedIds = Object.create(null);
    var usedTitles = Object.create(null);
    var sections = [];
    selected.forEach(function (item, index) {
      var title = sanitizeTemplateText(item.title, LIMITS.maxSectionTitle);
      if (!title) return;
      var titleKey = title.toLowerCase();
      if (own(usedTitles, titleKey)) {
        warnings.push("重複する見出し「" + title + "」を1つにまとめました。");
        return;
      }
      usedTitles[titleKey] = true;
      var matched = semanticForTitle(title);
      var id = makeUniqueId(inferSectionId(title, item.id), index, usedIds);
      var titleJa = matched ? matched.ja : title;
      var titleEn = matched ? matched.en : title;
      sections.push({
        id: id,
        title: title,
        titleJa: titleJa,
        titleEn: titleEn,
      });
    });
    return { sections: sections };
  }

  function collectRequiredInputs(explicitInputs, sections) {
    var output = ["title"];
    function add(value) {
      var normalized = normalizeRequiredInput(value);
      if (normalized && ALLOWED_REQUIRED_INPUTS.indexOf(normalized) >= 0 && output.indexOf(normalized) < 0 && output.length < LIMITS.maxRequiredInputs) {
        output.push(normalized);
      }
    }
    parseDelimitedRequiredInputs(explicitInputs).forEach(add);
    sections.forEach(function (section) {
      var matched = semanticForTitle(section.title);
      (matched ? matched.requiredInputs : []).forEach(add);
    });
    return output;
  }

  function safeTemplateName(extractedName, filename, language) {
    var name = sanitizeTemplateText(extractedName, LIMITS.maxTemplateName) || filenameStem(filename);
    if (!name || /^template$/i.test(name)) name = language === "ja" ? "カスタムテンプレート" : "Custom Template";
    return name;
  }

  function makeTemplateId(name, filename, format, source) {
    var base = sanitizeId(filenameStem(filename) || name, "template").slice(0, 38);
    return ("custom-" + base + "-" + fnv1a(format + "\n" + source)).slice(0, 64);
  }

  function extractByFormat(format, source) {
    if (format === "json") return extractJson(source);
    if (format === "markdown") return extractMarkdown(source);
    if (format === "typst") return extractTypst(source);
    if (format === "latex") return extractLatex(source);
    if (format === "html") return extractHtml(source);
    return extractText(source);
  }

  function validateTemplateDefinition(template) {
    var errors = [];
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      return { ok: false, errors: ["テンプレート定義がオブジェクトではありません。"] };
    }
    if (!/^custom-[a-z0-9][a-z0-9_-]{0,56}$/.test(String(template.id || ""))) errors.push("テンプレートIDが不正です。");
    if (!template.name || template.name !== sanitizeTemplateText(template.name, LIMITS.maxTemplateName)) errors.push("テンプレート名が不正です。");
    if (String(template.description || "") !== sanitizeTemplateText(template.description || "", LIMITS.maxDescription)) errors.push("説明文が不正です。");
    if (template.language !== "ja" && template.language !== "en") errors.push("言語は ja または en である必要があります。");
    if (template.layout !== "single-column" && template.layout !== "two-column") errors.push("段組設定が不正です。");
    if (!/^[a-z][a-z0-9_-]{0,55}$/.test(String(template.type || ""))) errors.push("文書種別が不正です。");
    if (!Array.isArray(template.sections) || !template.sections.length || template.sections.length > LIMITS.maxSections) {
      errors.push("節数が許容範囲外です。");
    } else {
      var ids = Object.create(null);
      template.sections.forEach(function (section) {
        var id = String(section && section.id || "");
        var title = String(section && section.title || "");
        if (!/^[a-z][a-z0-9_-]{0,55}$/.test(id) || own(ids, id)) errors.push("節IDが不正または重複しています。");
        ids[id] = true;
        if (!title || title !== sanitizeTemplateText(title, LIMITS.maxSectionTitle)) errors.push("節見出しが不正です。");
        if (String(section.titleJa || "") !== sanitizeTemplateText(section.titleJa || "", LIMITS.maxSectionTitle)) errors.push("日本語節見出しが不正です。");
        if (String(section.titleEn || "") !== sanitizeTemplateText(section.titleEn || "", LIMITS.maxSectionTitle)) errors.push("英語節見出しが不正です。");
      });
      if (!Array.isArray(template.sectionIds) || template.sectionIds.join("\u0000") !== template.sections.map(function (section) { return section.id; }).join("\u0000")) {
        errors.push("sectionIdsが節定義と一致しません。");
      }
    }
    if (!Array.isArray(template.requiredInputs) || template.requiredInputs.length > LIMITS.maxRequiredInputs || template.requiredInputs.some(function (item) {
      return ALLOWED_REQUIRED_INPUTS.indexOf(item) < 0;
    })) errors.push("必須入力候補が不正です。");
    return { ok: errors.length === 0, errors: errors };
  }

  function analyzeCustomTemplate(input, options) {
    var opts = options || {};
    var objectInput = input && typeof input === "object" && !Array.isArray(input) ? input : null;
    var text = typeof input === "string" ? input
      : objectInput && typeof objectInput.text === "string" ? objectInput.text
        : objectInput && typeof objectInput.content === "string" ? objectInput.content : null;
    var suppliedFilename = (objectInput && (objectInput.name || objectInput.filename)) || opts.filename || "";
    var filename = cleanFilename(suppliedFilename || "template.txt");
    var mime = (objectInput && (objectInput.type || objectInput.mimeType)) || opts.mimeType || "";
    var declaredSize = Number(objectInput && objectInput.size);
    var format = sniffBinaryFormat(text || "") || detectFormat(suppliedFilename ? filename : "", mime, text || "", opts.format || (objectInput && objectInput.format));

    if (format === "pdf" || format === "docx") {
      return failure(
        "unsupported-binary-format",
        "PDF/DOCXはブラウザーだけでは安全かつ正確に自動解析できません。JSON、Markdown、TXT、Typst、LaTeX、HTMLのいずれかで登録してください。",
        { format: format, filename: filename }
      );
    }
    if (SUPPORTED_FORMATS.indexOf(format) < 0) {
      return failure("unsupported-format", "このテンプレート形式には対応していません。", { format: format || "unknown", filename: filename });
    }
    if (text == null) {
      return failure(
        "text-required",
        objectInput && typeof objectInput.text === "function"
          ? "Fileオブジェクトは analyzeCustomTemplateFile() で読み込んでください。"
          : "解析するテキストがありません。",
        { format: format, filename: filename }
      );
    }
    if (text.length > LIMITS.maxSourceCharacters || (Number.isFinite(declaredSize) && declaredSize > LIMITS.maxSourceBytes)) {
      return failure("source-too-large", "テンプレートは512 KiB以下にしてください。", { format: format, filename: filename });
    }
    var byteLength = utf8ByteLength(text);
    if (byteLength > LIMITS.maxSourceBytes) {
      return failure("source-too-large", "テンプレートは512 KiB以下にしてください。", { format: format, filename: filename });
    }
    if (/\u0000/.test(text)) {
      return failure("binary-input", "バイナリデータはテキストテンプレートとして解析できません。", { format: format, filename: filename });
    }

    var extracted;
    try {
      extracted = extractByFormat(format, text);
    } catch (error) {
      return failure(
        format === "json" ? "invalid-json" : "parse-error",
        format === "json" ? "JSONの構文を確認してください。" : "テンプレートを解析できませんでした。",
        { format: format, filename: filename, detail: sanitizeTemplateText(error && error.message, 160) }
      );
    }

    var languageSample = [extracted.title].concat((extracted.sections || []).map(function (section) { return section.title; })).join("\n");
    var language = normalizeLanguage(extracted.language, languageSample || text.slice(0, 10000));
    var warnings = [];
    var normalized = normalizeSections(extracted.sections || [], language, warnings);
    if (normalized.error === "too-many-sections") {
      return failure("too-many-sections", "節は最大48個まで登録できます。", { format: format, filename: filename });
    }
    var name = safeTemplateName(extracted.title, filename, language);
    var description = sanitizeTemplateText(
      extracted.description || (language === "ja"
        ? filename + " から自動解釈したカスタムテンプレートです。"
        : "Custom template interpreted from " + filename + "."),
      LIMITS.maxDescription
    );
    var template = {
      customTemplateVersion: 1,
      id: makeTemplateId(name, filename, format, text),
      name: name,
      language: language,
      languages: [language],
      type: sanitizeId(extracted.type, "custom-paper"),
      layout: extracted.twoColumn ? "two-column" : "single-column",
      description: description,
      requiredInputs: collectRequiredInputs(extracted.requiredInputs, normalized.sections),
      sections: normalized.sections,
      sectionIds: normalized.sections.map(function (section) { return section.id; }),
      source: {
        kind: "uploaded-text-template",
        filename: filename,
        format: format,
        byteLength: byteLength,
        fingerprint: fnv1a(format + "\n" + text),
      },
    };
    var validation = validateTemplateDefinition(template);
    if (!validation.ok) {
      return failure("unsafe-template", "安全なテンプレート定義を作成できませんでした。", {
        format: format,
        filename: filename,
        errors: validation.errors,
      });
    }
    return {
      ok: true,
      unsupported: false,
      format: format,
      filename: filename,
      warnings: warnings,
      template: template,
      analysis: {
        language: language,
        layout: template.layout,
        sectionCount: template.sections.length,
        usedFallbackOutline: warnings.some(function (warning) { return warning.indexOf("標準的な論文構成") >= 0; }),
      },
    };
  }

  function analyzeCustomTemplateFile(file, options) {
    var opts = options || {};
    if (!file || typeof file !== "object") {
      return Promise.resolve(failure("file-required", "テンプレートファイルを選択してください。"));
    }
    var metadata = {
      name: file.name || opts.filename || "template.txt",
      type: file.type || opts.mimeType || "",
      size: Number(file.size),
      format: opts.format,
    };
    var format = detectFormat(metadata.name, metadata.type, "", metadata.format);
    if (format === "pdf" || format === "docx" || SUPPORTED_FORMATS.indexOf(format) < 0 || (Number.isFinite(metadata.size) && metadata.size > LIMITS.maxSourceBytes)) {
      metadata.text = "";
      return Promise.resolve(analyzeCustomTemplate(metadata, opts));
    }
    if (typeof file.text !== "function") {
      return Promise.resolve(failure("file-read-unsupported", "このブラウザーではファイルをテキストとして読み込めません。", { filename: cleanFilename(metadata.name), format: format }));
    }
    return Promise.resolve(file.text()).then(function (text) {
      metadata.text = text;
      return analyzeCustomTemplate(metadata, opts);
    }).catch(function (error) {
      return failure("file-read-error", "テンプレートファイルを読み込めませんでした。", {
        filename: cleanFilename(metadata.name),
        format: format,
        detail: sanitizeTemplateText(error && error.message, 160),
      });
    });
  }

  function isSupportedTemplateFilename(filename) {
    var format = FORMAT_BY_EXTENSION[extensionOf(filename)] || "";
    return SUPPORTED_FORMATS.indexOf(format) >= 0;
  }

  return {
    LIMITS: LIMITS,
    SUPPORTED_FORMATS: SUPPORTED_FORMATS,
    ALLOWED_REQUIRED_INPUTS: ALLOWED_REQUIRED_INPUTS,
    analyzeCustomTemplate: analyzeCustomTemplate,
    analyzeCustomTemplateFile: analyzeCustomTemplateFile,
    validateTemplateDefinition: validateTemplateDefinition,
    sanitizeTemplateText: sanitizeTemplateText,
    isSupportedTemplateFilename: isSupportedTemplateFilename,
  };
});
