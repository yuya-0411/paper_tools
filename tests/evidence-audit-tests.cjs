"use strict";

const assert = require("node:assert/strict");

require("../scripts/templates.js");
require("../scripts/core.js");
const auditApi = require("../scripts/evidence-audit.js");

const PT = globalThis.PaperTools;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

function project(templateId = "generic-ja") {
  const value = PT.createProject(templateId);
  value.title = "移動ロボットの評価";
  value.research.method = "センサ入力から経路を選択し、実験環境で評価した。";
  value.research.experimentalConditions = "同一条件で走行実験を行った。";
  value.research.results = "提案法の成功率は92.5%であった。";
  const results = value.manuscript.sections.find((section) => /result|evaluation|analysis/.test(section.id));
  if (results) results.content = "提案法の成功率は92.5%であった。";
  const method = value.manuscript.sections.find((section) => /method|system|procedure|experiment/.test(section.id));
  if (method) method.content = "センサ入力から経路を選択する。";
  return value;
}

function finding(result, ruleId) {
  return result.findings.find((item) => item.ruleId === ruleId);
}

test("CommonJS と PaperTools 名前空間の両方へ公開する", () => {
  assert.equal(typeof auditApi.auditEvidence, "function");
  assert.equal(PT.auditEvidence, auditApi.auditEvidence);
  assert.equal(PT.analyzeEvidence, auditApi.auditEvidence);
});

test("数値的結果に不足する図表・試行回数・ばらつき・比較・根拠を指摘する", () => {
  const result = PT.auditEvidence(project());
  assert.equal(finding(result, "results.visual").status, "recommended");
  assert.equal(finding(result, "numeric.trial-count").status, "missing");
  assert.equal(finding(result, "numeric.variability").status, "recommended");
  assert.equal(finding(result, "numeric.comparison").status, "recommended");
  assert.equal(finding(result, "numeric.traceability").status, "missing");
  for (const item of result.findings) {
    assert.ok(item.reason);
    assert.ok(item.action);
    assert.ok(item.targetSection);
    assert.ok(item.recommendedFormat);
  }
});

test("裏付けを追加すると数値チェックを確認済みにする", () => {
  const value = project();
  value.research.trialCount = "独立に20試行";
  value.research.statistics = "平均と標準偏差を算出した。";
  value.research.comparison = "同一条件で従来法と比較した。";
  value.research.dataAvailability = "project-results.csv に測定値を保存した。";
  value.assets.push({
    id: "result-figure",
    name: "result-chart.svg",
    displayName: "結果比較グラフ",
    role: "figure",
    target: "results-discussion",
    caption: "20試行の成功率。誤差棒は標準偏差。",
    origin: "self",
    size: 120,
    data: new Blob(["result-svg"]),
  });
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "results.visual").status, "ok");
  assert.equal(finding(result, "numeric.support").status, "ok");
  assert.equal(finding(result, "numeric.trial-count"), undefined);
  assert.equal(finding(result, "numeric.traceability"), undefined);
});

test("手法があって構成図がない場合だけ構成図を提案する", () => {
  const value = project();
  let result = PT.auditEvidence(value);
  assert.equal(finding(result, "method.diagram").status, "recommended");

  value.assets.push({
    id: "architecture",
    name: "architecture.svg",
    displayName: "システム構成図",
    role: "figure",
    target: "method",
    caption: "入力、経路選択、出力の構成。",
    origin: "self",
    size: 100,
    data: new Uint8Array([1, 2, 3]),
  });
  result = PT.auditEvidence(value);
  assert.equal(finding(result, "method.diagram").status, "ok");
});

test("図表の対象節・キャプション・引用元の不足を個別に返す", () => {
  const value = project();
  value.assets.push({
    id: "cited-figure",
    name: "prior-work.png",
    role: "figure",
    target: "deleted-section",
    caption: "",
    origin: "cited",
    source: "",
    size: 100,
    data: new Blob(["cited-image"]),
  });
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "asset.0.target").status, "missing");
  assert.equal(finding(result, "asset.0.caption").status, "missing");
  assert.equal(finding(result, "asset.0.source").status, "missing");
  assert.equal(finding(result, "asset.0.source").assetId, "cited-figure");
});

test("自作図には出典を要求せず基本情報を確認済みにする", () => {
  const value = PT.createProject("generic-ja");
  value.assets.push({
    id: "own-figure",
    name: "overview.svg",
    role: "figure",
    target: "introduction",
    caption: "研究全体の概要。",
    origin: "self",
    size: 100,
    data: new ArrayBuffer(1),
  });
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "assets.metadata").status, "ok");
  assert.equal(finding(result, "asset.0.source"), undefined);
  assert.equal(finding(result, "asset.0.origin"), undefined);
});

test("JSON復元で size だけ残った添付を本体ありと判定しない", () => {
  const value = project();
  value.assets.push(
    {
      id: "lost-result-figure",
      name: "result-chart.svg",
      displayName: "結果比較グラフ",
      role: "figure",
      target: "results-discussion",
      caption: "成功率の比較。",
      origin: "self",
      size: 120,
      data: null,
    },
    {
      id: "lost-architecture",
      name: "architecture.svg",
      displayName: "システム構成図",
      role: "figure",
      target: "method",
      caption: "入力から出力までの構成。",
      origin: "self",
      size: 100,
      data: null,
    },
    {
      id: "lost-result-data",
      name: "results.csv",
      role: "data",
      target: "results-discussion",
      caption: "試行ごとの成功率。",
      origin: "self",
      size: 240,
      data: null,
    },
  );

  const restored = JSON.parse(JSON.stringify(value));
  const result = PT.auditEvidence(restored);

  assert.equal(finding(result, "results.visual").status, "recommended");
  assert.equal(finding(result, "method.diagram").status, "recommended");
  assert.equal(finding(result, "numeric.traceability").status, "missing");
  for (let index = 0; index < restored.assets.length; index += 1) {
    const payloadFinding = finding(result, `asset.${index}.payload`);
    assert.equal(payloadFinding.status, "missing");
    assert.equal(payloadFinding.assetId, restored.assets[index].id);
    assert.match(payloadFinding.action, /再添付|Reattach/);
  }
  assert.equal(finding(result, "assets.metadata"), undefined);
});

test("空の文字列・Blob・ArrayBuffer・TypedArrayを本体ありと判定しない", () => {
  const value = PT.createProject("generic-ja");
  const emptyPayloads = ["", new Blob([]), new ArrayBuffer(0), new Uint8Array(0)];
  value.assets = emptyPayloads.map((data, index) => ({
    id: `empty-${index}`,
    name: `empty-${index}.bin`,
    role: "other",
    target: "introduction",
    caption: "空の添付を検証する。",
    origin: "self",
    size: 100,
    data,
  }));

  const result = PT.auditEvidence(value);
  emptyPayloads.forEach((_data, index) => {
    assert.equal(finding(result, `asset.${index}.payload`).status, "missing");
  });
});

test("文献レビューには比較表を提案する", () => {
  const value = PT.createProject("literature-review");
  value.research.searchStrategy = "データベースと検索式を記録した。";
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "type.review.comparison-table").status, "recommended");
  assert.equal(finding(result, "numeric.trial-count"), undefined);
});

test("研究計画書には工程表を提案し未実施の結果を要求しない", () => {
  const value = PT.createProject("research-proposal");
  value.research.method = "候補手法を段階的に評価する。";
  value.research.researchPlan = "設計、実装、評価の順に進める。";
  value.research.schedule = "1か月目に設計、2か月目に実装する。";
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "type.proposal.timeline").status, "recommended");
  assert.equal(finding(result, "results.visual"), undefined);
});

test("ロボティクス論文には実験配置図を提案する", () => {
  const value = PT.createProject("robotics-experiment");
  value.research.method = "移動ロボットを制御した。";
  value.research.experimentalConditions = "屋内環境で走行した。";
  const result = PT.auditEvidence(value);
  assert.equal(finding(result, "type.robotics.setup").status, "recommended");
});

test("同じ入力には同じ結果を返し、時刻や生成内容を混入しない", () => {
  const value = project();
  assert.deepEqual(PT.auditEvidence(value), PT.auditEvidence(value));
  assert.equal(JSON.stringify(PT.auditEvidence(value)).includes("generatedAt"), false);
});

test("制御文字を除去し抜粋と件数を上限内に収める", () => {
  const value = project();
  value.research.results = `成功率は91%であった。\u0000${"長い説明".repeat(300)}`;
  value.assets = Array.from({ length: 30 }, (_, index) => ({
    id: `asset-${index}`,
    name: `figure-${index}.png`,
    role: "figure",
    target: "",
    caption: "",
    origin: "cited",
  }));
  const result = PT.auditEvidence(value, { maxAssets: 5, maxFindings: 7, maxExcerptChars: 80 });
  assert.equal(result.inspected.assets, 5);
  assert.ok(result.findings.length <= 7);
  assert.equal(result.truncated.assets, true);
  assert.equal(result.truncated.findings, true);
  result.findings.forEach((item) => item.evidence.forEach((itemEvidence) => {
    assert.ok(itemEvidence.length <= 80);
    assert.equal(itemEvidence.includes("\u0000"), false);
  }));
});

test("空または不正な入力でも安全な結果を返す", () => {
  const result = PT.auditEvidence(null);
  assert.equal(result.version, 1);
  assert.deepEqual(Object.keys(result.summary), ["missing", "recommended", "ok", "total"]);
  assert.equal(Array.isArray(result.findings), true);
});

if (!process.exitCode) {
  process.stdout.write(`\n${passed}/${passed} evidence audit tests passed.\n`);
}
