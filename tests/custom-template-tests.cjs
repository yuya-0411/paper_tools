"use strict";

const assert = require("node:assert/strict");
const api = require("../scripts/custom-templates.js");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function assertSafeTemplate(result) {
  assert.equal(result.ok, true, result.message || "analysis should succeed");
  assert.equal(api.validateTemplateDefinition(result.template).ok, true);
  assert.match(result.template.id, /^custom-[a-z0-9][a-z0-9_-]+$/);
  assert.ok(result.template.sections.length <= api.LIMITS.maxSections);
  result.template.sections.forEach((section) => {
    assert.match(section.id, /^[a-z][a-z0-9_-]*$/);
    assert.equal(/[<>]/.test(section.title), false);
  });
}

test("CommonJSとPaperTools名前空間に同じAPIを公開する", () => {
  assert.equal(globalThis.PaperTools.customTemplates, api);
  assert.equal(globalThis.PaperTools.analyzeCustomTemplate, api.analyzeCustomTemplate);
  assert.equal(typeof api.analyzeCustomTemplateFile, "function");
});

test("Markdownの文書タイトルと最上位の節を抽出する", () => {
  const source = `---
lang: ja
title: ロボット論文テンプレート
columns: 2
---
# 論文タイトル
## 1. はじめに
### 背景の詳細
## 2. 提案手法
## 3. 実験条件
## 4. 結果
## 5. 結論
## 参考文献

\`\`\`
## コード中の偽見出し
\`\`\``;
  const result = api.analyzeCustomTemplate({ name: "robot.md", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name, "ロボット論文テンプレート");
  assert.equal(result.template.language, "ja");
  assert.equal(result.template.layout, "two-column");
  assert.deepEqual(result.template.sectionIds, ["introduction", "method", "experimental-setup", "results", "conclusion", "references"]);
  assert.ok(result.template.requiredInputs.includes("method"));
  assert.ok(result.template.requiredInputs.includes("experimentalConditions"));
  assert.equal(result.template.sections.some((section) => section.title.includes("偽見出し")), false);
});

test("JSONの明示設定を安全な定義に正規化する", () => {
  const source = JSON.stringify({
    name: '<img src=x onerror="alert(1)">安全<script>alert(2)</script>テンプレート',
    language: "en-GB",
    layout: "two-column",
    type: "Journal Paper<script>",
    requiredInputs: ["title", "methods", "unknown", "__proto__"],
    sections: [
      { id: "1 BAD/id", title: "Introduction" },
      { id: "__proto__", title: "Method" },
      { id: "method", title: "Method" },
      { id: "refs", title: "References<script>bad()</script>" },
    ],
  });
  const result = api.analyzeCustomTemplate({ name: "unsafe.json", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name.replace(/\s+/g, ""), "安全テンプレート");
  assert.equal(result.template.language, "en");
  assert.equal(result.template.layout, "two-column");
  assert.equal(result.template.sections.filter((section) => section.title === "Method").length, 1);
  assert.deepEqual(result.template.requiredInputs.slice(0, 2), ["title", "method"]);
  assert.equal(result.template.requiredInputs.includes("unknown"), false);
  assert.equal(JSON.stringify(result.template).includes("onerror"), false);
  assert.equal(JSON.stringify(result.template).includes("alert"), false);
});

test("TXTの番号付き見出しと言語を抽出する", () => {
  const source = `Template: 実験報告書
Language: ja
1. 目的
2. 使用機器
3. 実験方法
4. 結果
5. 考察
6. 結論`;
  const result = api.analyzeCustomTemplate({ name: "report.txt", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name, "実験報告書");
  assert.deepEqual(result.template.sectionIds, ["objective", "equipment", "experimental-setup", "results", "discussion", "conclusion"]);
  assert.ok(result.template.requiredInputs.includes("equipment"));
});

test("Typstの見出し・言語・2段組指定を抽出する", () => {
  const source = `#set document(title: [Conference Template])
#set text(lang: "en")
#show: columns.with(2)
= Paper title
== Abstract
== Introduction
=== Motivation
== Proposed Method
== Results
== Conclusion
// == Ignored comment`;
  const result = api.analyzeCustomTemplate({ name: "conference.typ", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name, "Conference Template");
  assert.equal(result.template.layout, "two-column");
  assert.equal(result.template.language, "en");
  assert.deepEqual(result.template.sectionIds, ["abstract", "introduction", "method", "results", "conclusion"]);
});

test("LaTeXのsectionだけを採用し、コメントとsubsectionを除外する", () => {
  const source = String.raw`\documentclass[twocolumn]{article}
\usepackage[english]{babel}
\title{Journal \textbf{Template}}
\begin{document}
\section{Introduction}
\subsection{Detailed Background}
% \section{Commented Out}
\section{Materials and Methods}
\section{Results and Discussion}
\section*{References}
\end{document}`;
  const result = api.analyzeCustomTemplate({ name: "journal.tex", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name, "Journal Template");
  assert.equal(result.template.layout, "two-column");
  assert.deepEqual(result.template.sectionIds, ["introduction", "method", "results-discussion", "references"]);
});

test("HTMLは危険要素と属性を保存せず見出しだけを解釈する", () => {
  const source = `<!doctype html>
<html lang="ja"><head><title>研究&lt;img src=x onerror=alert(1)&gt;テンプレート</title>
<style>h2 { column-count: 99 }</style><script>alert("bad")</script></head>
<body data-columns="2"><h1>論文タイトル</h1>
<h2 onclick="evil()">概要</h2><h2><img src=x onerror="evil()">提案手法</h2>
<h2>結果 &amp; 考察</h2><h2>参考文献<script>evil()</script></h2></body></html>`;
  const result = api.analyzeCustomTemplate({ name: "paper.html", text: source });
  assertSafeTemplate(result);
  assert.equal(result.template.name.replace(/\s+/g, ""), "研究テンプレート");
  assert.equal(result.template.layout, "two-column");
  assert.deepEqual(result.template.sectionIds, ["abstract", "method", "results-discussion", "references"]);
  const serialized = JSON.stringify(result.template);
  assert.equal(/(?:onclick|onerror|<script|evil\(|alert\()/i.test(serialized), false);
});

test("見出しのないテキストは安全な標準アウトラインへフォールバックする", () => {
  const result = api.analyzeCustomTemplate({ name: "notes.txt", text: "This file only explains formatting preferences in prose." });
  assertSafeTemplate(result);
  assert.equal(result.analysis.usedFallbackOutline, true);
  assert.deepEqual(result.template.sectionIds, ["abstract", "introduction", "method", "results", "discussion", "conclusion", "references"]);
});

test("同一入力から常に同じIDを生成する", () => {
  const input = { name: "stable.md", text: "# Template\n## Introduction\n## Method" };
  const first = api.analyzeCustomTemplate(input);
  const second = api.analyzeCustomTemplate(input);
  assert.equal(first.template.id, second.template.id);
  assert.equal(first.template.source.fingerprint, second.template.source.fingerprint);
});

test("ファイル名を省略した直接文字列入力は内容から形式を判定する", () => {
  const result = api.analyzeCustomTemplate("# Template\n## Introduction\n## Method");
  assertSafeTemplate(result);
  assert.equal(result.format, "markdown");
  assert.deepEqual(result.template.sectionIds, ["introduction", "method"]);
});

test("PDFとDOCXは本文を読まず明確にunsupportedとする", async () => {
  for (const filename of ["journal.pdf", "publisher.docx"]) {
    let read = false;
    const result = await api.analyzeCustomTemplateFile({
      name: filename,
      size: 10,
      type: filename.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: async () => {
        read = true;
        return "not reached";
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.unsupported, true);
    assert.equal(result.code, "unsupported-binary-format");
    assert.equal(read, false);
  }
});

test("入力サイズ、バイナリ、節数の上限を拒否する", () => {
  const tooLarge = api.analyzeCustomTemplate({ name: "huge.txt", text: "a".repeat(api.LIMITS.maxSourceBytes + 1) });
  assert.equal(tooLarge.code, "source-too-large");
  const binary = api.analyzeCustomTemplate({ name: "binary.txt", text: "abc\u0000def" });
  assert.equal(binary.code, "binary-input");
  const disguisedPdf = api.analyzeCustomTemplate({ name: "paper.txt", text: "%PDF-1.7 fake" });
  assert.equal(disguisedPdf.code, "unsupported-binary-format");
  const tooMany = api.analyzeCustomTemplate({
    name: "many.json",
    text: JSON.stringify({ sections: Array.from({ length: api.LIMITS.maxSections + 1 }, (_, index) => `Unique section ${index + 1}`) }),
  });
  assert.equal(tooMany.code, "too-many-sections");
});

test("対応拡張子の判定を限定し、File.text経由でも解析できる", async () => {
  assert.equal(api.isSupportedTemplateFilename("paper.md"), true);
  assert.equal(api.isSupportedTemplateFilename("paper.exe"), false);
  assert.equal(api.analyzeCustomTemplate({ name: "paper.exe", text: "Introduction" }).code, "unsupported-format");
  let unsupportedRead = false;
  const unsupported = await api.analyzeCustomTemplateFile({
    name: "paper.exe",
    size: 20,
    text: async () => {
      unsupportedRead = true;
      return "Introduction";
    },
  });
  assert.equal(unsupported.code, "unsupported-format");
  assert.equal(unsupportedRead, false);
  const forcedPdf = api.analyzeCustomTemplate({ name: "paper.pdf", text: "Introduction", format: "text" });
  assert.equal(forcedPdf.code, "unsupported-binary-format");
  const result = await api.analyzeCustomTemplateFile({
    name: "outline.md",
    type: "text/markdown",
    size: 40,
    text: async () => "# Template\n## Introduction\n## Results",
  });
  assertSafeTemplate(result);
  assert.deepEqual(result.template.sectionIds, ["introduction", "results"]);
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
  process.stdout.write(`\n${tests.length - failed}/${tests.length} custom-template tests passed.\n`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
