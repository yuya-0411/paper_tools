"use strict";

const assert = require("node:assert/strict");

require("../scripts/templates.js");
require("../scripts/core.js");
require("../scripts/generator.js");
require("../scripts/zip.js");
require("../scripts/export.js");

const PT = globalThis.PaperTools;
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function contract(prefix) {
  return Object.fromEntries(
    PT.CHAPTER_CONTRACT_FIELDS.map((field, index) => [field.key, `${prefix}-${index + 1}`]),
  );
}

function chapter(id, title, prefix) {
  return {
    id,
    title,
    content: `${title}の本文`,
    chapterContract: contract(prefix),
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

test("v1プロジェクトをv2へ移行し空の章契約を補う", () => {
  const legacy = {
    schemaVersion: 1,
    id: "project_legacy",
    name: "旧形式",
    title: "旧形式の論文",
    templateId: "generic-ja",
    manuscript: {
      sections: [{ id: "abstract", title: "概要", content: "旧本文" }],
      advice: [],
    },
  };

  const normalized = PT.normalizeProject(legacy);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.manuscript.outlineCustomized, false);
  assert.deepEqual(
    Object.keys(normalized.manuscript.sections[0].chapterContract),
    PT.CHAPTER_CONTRACT_FIELDS.map((field) => field.key),
  );
  assert.ok(
    Object.values(normalized.manuscript.sections[0].chapterContract).every((value) => value === ""),
  );
  assert.equal(normalized.manuscript.sections[0].content, "旧本文");
});

test("カスタム章立ての並べ替えと削除状態を正規化後も維持する", () => {
  const project = PT.createProject("generic-ja", { title: "章順テスト" });
  const first = chapter("chapter-one", "第1章", "ONE");
  const second = chapter("chapter-two", "第2章", "TWO");
  const removed = chapter("chapter-removed", "削除対象", "REMOVED");
  project.manuscript.outlineCustomized = true;
  project.manuscript.sections = [first, removed, second];
  project.manuscript.sections.splice(1, 1);
  project.manuscript.sections.reverse();

  const normalized = PT.normalizeProject(project);
  assert.equal(normalized.manuscript.outlineCustomized, true);
  assert.deepEqual(normalized.manuscript.sections.map((section) => section.id), ["chapter-two", "chapter-one"]);
  assert.equal(normalized.manuscript.sections.some((section) => section.id === "chapter-removed"), false);
  assert.equal(normalized.manuscript.sections[0].chapterContract.problem, "TWO-1");
});

test("既存章の名前を変更しても正規化と草稿再生成で元へ戻らない", () => {
  const project = PT.createProject("generic-ja", { language: "ja" });
  project.manuscript.outlineCustomized = true;
  project.manuscript.sections[0].title = "第1章　研究の入口";

  const normalized = PT.normalizeProject(project);
  assert.equal(normalized.manuscript.sections[0].title, "第1章　研究の入口");

  const generated = PT.generateManuscript(normalized);
  assert.equal(generated.sections[0].title, "第1章　研究の入口");
});

test("章契約を8個の既知フィールドだけへ安全に正規化する", () => {
  const source = {
    problem: "問題\u0000A\r\nB",
    priorGap: 42,
    proposal: "提案",
    hypothesis: "仮説",
    supportingEvidence: "実験",
    supportedConclusion: "結論",
    limitations: "限界",
    thesisContribution: "全体への回答",
    unexpected: "保持してはいけない値",
  };
  source.proposal = "提".repeat(PT.CHAPTER_CONTRACT_MAX_CHARS + 50);

  const normalized = PT.normalizeChapterContract(source);
  assert.deepEqual(Object.keys(normalized), PT.CHAPTER_CONTRACT_FIELDS.map((field) => field.key));
  assert.equal(normalized.problem, "問題A\nB");
  assert.equal(normalized.priorGap, "42");
  assert.equal(normalized.proposal.length, PT.CHAPTER_CONTRACT_MAX_CHARS);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "unexpected"), false);
  assert.deepEqual(PT.chapterContractProgress({ chapterContract: normalized }), {
    completed: 8,
    total: 8,
    percent: 100,
  });
});

test("博士論文全体の中心研究課題を5000文字へ制限する", () => {
  assert.equal(PT.CENTRAL_RESEARCH_QUESTION_MAX_CHARS, 5000);
  const project = PT.createProject("generic-ja");
  project.research.centralResearchQuestion = "問".repeat(5100);
  assert.equal(
    PT.normalizeProject(project).research.centralResearchQuestion.length,
    PT.CENTRAL_RESEARCH_QUESTION_MAX_CHARS,
  );
});

test("履歴復元では現在の添付本体を保ち章への関連付けだけを復元する", () => {
  const currentBlob = { marker: "current-binary" };
  const currentAssets = [{
    id: "asset-one",
    target: "",
    caption: "現在のキャプション",
    data: currentBlob,
  }, {
    id: "asset-new",
    target: "chapter-new",
    data: null,
  }];
  const snapshotAssets = [{
    id: "asset-one",
    target: "chapter-restored",
    caption: "古いキャプション",
    data: null,
  }];

  const restored = PT.restoreAssetTargets(currentAssets, snapshotAssets);
  assert.equal(restored[0].target, "chapter-restored");
  assert.equal(restored[0].caption, "現在のキャプション");
  assert.equal(restored[0].data, currentBlob);
  assert.equal(restored[1].target, "chapter-new");
  assert.notEqual(restored[0], currentAssets[0]);
});

test("将来schemaVersionを正規化と生成の両方で拒否する", () => {
  const future = {
    schemaVersion: PT.SCHEMA_VERSION + 1,
    id: "project_future",
    templateId: "generic-ja",
    manuscript: { sections: [] },
  };
  assert.throws(() => PT.normalizeProject(future), /新しい形式/);
  assert.throws(() => PT.generateManuscript(future), /新しい形式/);
});

test("草稿生成後も章順・outlineCustomized・章契約を保持する", () => {
  const project = PT.createProject("generic-ja", { title: "生成保持テスト" });
  project.manuscript.outlineCustomized = true;
  project.manuscript.sections = [
    chapter("chapter-results", "第3章 結果", "RESULTS"),
    chapter("chapter-method", "第2章 手法", "METHOD"),
  ];
  const normalized = PT.normalizeProject(project);
  const before = JSON.stringify(normalized);
  const generated = PT.generateManuscript(normalized);

  assert.equal(JSON.stringify(normalized), before, "生成処理が入力を書き換えた");
  assert.equal(generated.outlineCustomized, true);
  assert.deepEqual(generated.sections.map((section) => section.id), ["chapter-results", "chapter-method"]);
  assert.deepEqual(generated.sections[0].chapterContract, contract("RESULTS"));
  assert.deepEqual(generated.sections[1].chapterContract, contract("METHOD"));

  normalized.manuscript = Object.assign({}, normalized.manuscript, generated);
  const savedShape = PT.normalizeProject(normalized);
  assert.equal(savedShape.manuscript.outlineCustomized, true);
  assert.deepEqual(savedShape.manuscript.sections.map((section) => section.id), ["chapter-results", "chapter-method"]);
  assert.deepEqual(savedShape.manuscript.sections[0].chapterContract, contract("RESULTS"));
});

test("章契約はJSONバックアップで復元できるが生成本文とTypst本文へ混入しない", () => {
  const secretPlanningText = "CONTRACT_ONLY_DO_NOT_RENDER";
  const project = PT.createProject("generic-ja", { title: "非混入テスト" });
  project.manuscript.outlineCustomized = true;
  project.manuscript.sections = [{
    id: "chapter-private-plan",
    title: "第1章",
    content: "公開する章本文",
    chapterContract: Object.assign(PT.emptyChapterContract(), {
      problem: secretPlanningText,
      limitations: "計画段階の限界メモ",
    }),
    updatedAt: PT.nowIso(),
  }];
  const normalized = PT.normalizeProject(project);
  const generated = PT.generateManuscript(normalized);

  assert.equal(generated.text.includes(secretPlanningText), false);
  assert.equal(generated.sections[0].content.includes(secretPlanningText), false);
  assert.equal(PT.renderTypst(normalized).includes(secretPlanningText), false);

  const serialized = PT.serializeProject(normalized);
  assert.ok(serialized.includes(secretPlanningText), "復元用JSONから章契約が失われた");
  const restored = PT.normalizeProject(JSON.parse(serialized));
  assert.equal(restored.manuscript.sections[0].chapterContract.problem, secretPlanningText);
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      process.stderr.write(`FAIL ${item.name}\n${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} chapter outline tests passed.\n`);
})();
