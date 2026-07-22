(function (root, factory) {
  "use strict";
  const api = factory(root.PaperTools || {});
  root.PaperToolsTestSuite = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (PT) {
  "use strict";

  function assert(condition, message) {
    if (!condition) throw new Error(message || "Assertion failed");
  }

  function equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message || "Values differ"}: expected ${String(expected)}, got ${String(actual)}`);
    }
  }

  function sampleProject(language) {
    const project = PT.createProject(language === "en" ? "generic-en" : "generic-ja", {
      name: language === "en" ? "Navigation study" : "経路計画研究",
      title: language === "en" ? "Evaluation of a Navigation Method" : "移動ロボット経路計画法の評価",
      language,
      field: language === "en" ? "Robotics" : "ロボティクス",
    });
    project.authors = [
      {
        id: "author_1",
        name: language === "en" ? "A. Researcher" : "研究 太郎",
        affiliation: "Example Laboratory",
        email: "",
        orcid: "",
      },
    ];
    project.research.objective =
      language === "en"
        ? "Evaluate whether the supplied method reduces path length under the recorded test conditions."
        : "記録済みの実験条件において，提案手法が経路長を短縮するかを評価する．";
    project.research.background =
      language === "en" ? "Navigation quality affects mobile robot operation." : "移動ロボットの運用では経路品質が重要である．";
    project.research.method =
      language === "en" ? "The supplied planner was compared with the registered baseline." : "入力済みの計画器を登録済みの比較手法と比較した．";
    project.research.experimentalConditions =
      language === "en" ? "Ten recorded trials were conducted in the same environment." : "同一環境で記録済みの10試行を実施した．";
    project.research.results =
      language === "en" ? "The recorded median path length was 8.2 m." : "記録済みの経路長中央値は8.2 mであった．";
    project.research.discussion =
      language === "en" ? "The supplied result supports comparison only under the recorded conditions." : "入力済みの結果が支持する範囲は，記録済みの条件内に限られる．";
    project.research.conclusion =
      language === "en" ? "The method was evaluated under the recorded conditions." : "提案手法を記録済みの条件で評価した．";
    project.references = [
      {
        id: "ref_1",
        key: "verified2026",
        type: "article",
        title: "Verified Reference",
        authors: "A. Author",
        year: "2026",
        venue: "Example Journal",
        doi: "",
        url: "",
        note: "",
      },
    ];
    return project;
  }

  const tests = [
    {
      name: "8種類のテンプレートを同梱する",
      run: () => {
        equal(PT.TEMPLATES.length, 8, "template count");
        const ids = new Set(PT.TEMPLATES.map((item) => item.id));
        [
          "generic-ja",
          "generic-en",
          "engineering-two-column",
          "robotics-experiment",
          "short-paper",
          "literature-review",
          "research-proposal",
          "experiment-report",
        ].forEach((id) => assert(ids.has(id), `missing template: ${id}`));
      },
    },
    {
      name: "日本語草稿を決定的に生成する",
      run: () => {
        const project = sampleProject("ja");
        const first = PT.generateManuscript(project);
        const second = PT.generateManuscript(project);
        equal(JSON.stringify(first), JSON.stringify(second), "generation must be deterministic");
        assert(first.sections.some((section) => section.content.includes("8.2 m")), "verified result must appear");
      },
    },
    {
      name: "英語テンプレートは英語見出しを使う",
      run: () => {
        const project = sampleProject("en");
        project.englishVariant = "british";
        project.documentType = "journal-paper";
        const generated = PT.generateManuscript(project);
        assert(generated.sections.some((section) => section.title === "Introduction"), "English heading missing");
        assert(PT.renderTypst(project).includes('lang: "en", region: "GB"'), "British English Typst region missing");
        assert(PT.projectToPrintHtml(project).includes('<html lang="en-GB">'), "British English HTML language missing");
        equal(PT.normalizeProject(project).documentType, "journal-paper", "document type was lost");
      },
    },
    {
      name: "不足情報を明示的なプレースホルダーにする",
      run: () => {
        const project = PT.createProject("generic-ja", { title: "不足入力テスト" });
        const text = PT.generateManuscript(project).text;
        assert(/\[(TODO|DATA NEEDED|FIGURE NEEDED|CITATION NEEDED|VERIFY)/.test(text), "placeholder missing");
      },
    },
    {
      name: "登録していない参考文献を生成しない",
      run: () => {
        const project = sampleProject("ja");
        const text = PT.generateManuscript(project).text;
        assert(text.includes("Verified Reference"), "registered reference missing");
        assert(!text.includes("Imaginary Reference"), "unregistered reference appeared");
      },
    },
    {
      name: "簡易入力だけでも構成案へ内容を反映する",
      run: () => {
        const project = PT.createProject("generic-ja", { title: "簡易入力テスト" });
        project.research.simpleDescription = "移動ロボットの経路選択を検討した．";
        project.research.achievements = "記録済みの条件で走行を確認した．";
        project.research.keyMessage = "入力済み条件の範囲で挙動を整理した．";
        const generated = PT.generateManuscript(project);
        assert(generated.text.includes("移動ロボットの経路選択"), "simple description missing");
        assert(generated.text.includes("記録済みの条件で走行"), "achievement missing");
      },
    },
    {
      name: "助言は重要度・対象・追加内容を持つ",
      run: () => {
        const project = PT.createProject("robotics-experiment", { title: "助言テスト" });
        const manuscript = PT.generateManuscript(project);
        const advice = PT.analyzeProject(project, manuscript);
        assert(advice.length > 0, "advice missing");
        advice.forEach((item) => {
          assert(["required", "recommended", "optional"].includes(item.severity), "invalid severity");
          assert(item.title && item.reason && item.target && item.action, "incomplete advice");
        });
      },
    },
    {
      name: "危険なアップロード名を拒否する",
      run: () => {
        const result = PT.validateUpload({ name: "../secret.txt", size: 10 }, PT.DEFAULT_SETTINGS);
        assert(!result.ok, "unsafe filename accepted");
      },
    },
    {
      name: "一時保存モードでプロジェクトを再取得できる",
      run: async () => {
        const repository = new PT.Repository();
        repository.mode = "memory";
        const saved = await repository.saveProject(sampleProject("ja"));
        const loaded = await repository.getProject(saved.id);
        assert(loaded && loaded.title === saved.title, "saved project was not restored");
        const list = await repository.listProjects();
        equal(list.length, 1, "stored project count");
        await repository.deleteProject(saved.id);
        equal((await repository.listProjects()).length, 0, "deleted project remained");
      },
    },
    {
      name: "Typstの特殊文字をエスケープする",
      run: () => {
        const escaped = PT.escapeTypst("#value_[x] $100");
        assert(escaped.includes("\\#") && escaped.includes("\\_") && escaped.includes("\\$"), "Typst escaping failed");
      },
    },
    {
      name: "JSONバックアップからバイナリを除外する",
      run: () => {
        const project = sampleProject("ja");
        project.assets.push({ id: "asset_1", name: "data.txt", type: "text/plain", size: 3, data: new Blob(["abc"]) });
        const serialized = PT.serializeProject(project);
        assert(serialized.includes("data.txt"), "asset metadata missing");
        assert(!serialized.includes('"data"'), "binary field leaked into JSON");
      },
    },
    {
      name: "印刷HTMLで入力文字列をエスケープする",
      run: () => {
        const project = sampleProject("ja");
        project.title = '<img src=x onerror="alert(1)">';
        const html = PT.projectToPrintHtml(project);
        assert(!html.includes("<img src=x"), "raw HTML injection remained");
        assert(html.includes("&lt;img"), "escaped title missing");
      },
    },
    {
      name: "有効なZIPを生成しパストラバーサルを拒否する",
      run: async () => {
        const blob = await PT.createZip([{ name: "paper.typ", data: "= Test" }]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        equal(bytes[0], 0x50, "ZIP signature byte 1");
        equal(bytes[1], 0x4b, "ZIP signature byte 2");
        let rejected = false;
        try {
          await PT.createZip([{ name: "../secret.txt", data: "x" }]);
        } catch (_error) {
          rejected = true;
        }
        assert(rejected, "traversal path accepted");
      },
    },
    {
      name: "プロジェクトZIPに主要成果物を含める",
      run: async () => {
        const project = sampleProject("ja");
        const generated = PT.generateManuscript(project);
        project.manuscript = Object.assign({}, project.manuscript, generated);
        const blob = await PT.createProjectArchive(project);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const decoded = new TextDecoder().decode(bytes);
        ["project.json", "paper.typ", "references.yml", "references.bib", "manifest.json"].forEach((name) => assert(decoded.includes(name), `archive entry missing: ${name}`));
      },
    },
    {
      name: "英語プロジェクトの初期見出しを英語にする",
      run: () => {
        const project = PT.createProject("generic-en", { language: "en", title: "English paper" });
        assert(project.manuscript.sections.some((section) => section.title === "Introduction"), "English section title missing");
        assert(!project.manuscript.sections.some((section) => section.title === "はじめに"), "Japanese default title remained");
      },
    },
    {
      name: "言語を往復しても既定見出しを正しく切り替える",
      run: () => {
        let project = PT.createProject("engineering-two-column", { language: "ja", title: "見出し切替" });
        project.language = "en";
        project = PT.normalizeProject(project);
        assert(project.manuscript.sections.some((section) => section.title === "Abstract"), "English default heading missing");
        project.language = "ja";
        project = PT.normalizeProject(project);
        assert(project.manuscript.sections.some((section) => section.title === "概要"), "Japanese default heading was not restored");
      },
    },
    {
      name: "旧実験フィールドを実験条件へ移行する",
      run: () => {
        const project = PT.createProject("generic-ja", { title: "移行テスト" });
        project.research.experimentalConditions = "";
        project.research.experiment = "旧形式の実験条件";
        const normalized = PT.normalizeProject(project);
        equal(normalized.research.experimentalConditions, "旧形式の実験条件", "legacy experiment was not migrated");
      },
    },
    {
      name: "テンプレート外の追加セクションを保持する",
      run: () => {
        const project = sampleProject("ja");
        project.manuscript.sections.push({ id: "appendix-a", title: "付録A", content: "追加内容" });
        const normalized = PT.normalizeProject(project);
        const section = normalized.manuscript.sections.find((item) => item.id === "appendix-a");
        assert(section && section.content === "追加内容", "custom section was lost");
      },
    },
    {
      name: "詳細な実験情報を草稿と助言へ反映する",
      run: () => {
        const project = sampleProject("ja");
        project.research.experimentalConditions = "温度25度で測定した．";
        project.research.comparison = "登録済みの基準手法と比較した．";
        project.research.trialCount = "独立に10試行した．";
        project.research.reproducibility = "乱数シードとソフトウェア版を記録した．";
        const generated = PT.generateManuscript(project);
        assert(generated.text.includes("独立に10試行"), "trial count missing from manuscript");
        assert(generated.text.includes("乱数シード"), "reproducibility details missing from manuscript");
        assert(generated.text.includes("基準手法"), "comparison missing from manuscript");
        const advice = PT.analyzeProject(project, generated);
        assert(!advice.some((item) => item.id === "reproducibility.trial-count"), "filled trial count still flagged");
      },
    },
    {
      name: "評価指標と統計情報を分離して診断する",
      run: () => {
        const project = sampleProject("ja");
        project.research.metrics = "経路長（m）";
        project.research.trialCount = "独立に10試行";
        let advice = PT.analyzeProject(project);
        assert(advice.some((item) => item.id === "reproducibility.statistics"), "missing statistical analysis was not reported");
        project.research.statistics = "中央値と四分位範囲を報告した．";
        const generated = PT.generateManuscript(project);
        assert(generated.text.includes("四分位範囲"), "statistical information missing from manuscript");
        advice = PT.analyzeProject(project, generated);
        assert(!advice.some((item) => item.id === "reproducibility.statistics"), "filled statistical analysis still flagged");
      },
    },
    {
      name: "編集条件を生成メタデータと助言へ反映する",
      run: () => {
        const project = sampleProject("ja");
        project.documentType = "journal-paper";
        project.pageTarget = "8ページ";
        project.targetAudience = "制御工学の研究者";
        project.submissionNotes = "投稿先書式を確認する";
        const generated = PT.generateManuscript(project);
        equal(generated.metadata.pageTarget, "8ページ", "page target missing from generated metadata");
        assert(PT.analyzeProject(project, generated).some((item) => item.id === "editorial.constraints"), "editorial constraints advice missing");
      },
    },
    {
      name: "一時保存モードでも添付Blobを保持する",
      run: async () => {
        const repository = new PT.Repository();
        repository.mode = "memory";
        const project = sampleProject("ja");
        project.assets.push({ id: "asset_blob", name: "raw.txt", type: "text/plain", size: 3, data: new Blob(["abc"]) });
        const saved = await repository.saveProject(project);
        const loaded = await repository.getProject(saved.id);
        assert(loaded.assets[0].data instanceof Blob, "Blob payload was discarded");
        equal(await loaded.assets[0].data.text(), "abc", "Blob contents changed");
      },
    },
    {
      name: "終了直前の同期退避から未保存編集を回復する",
      run: async () => {
        const originalStorage = globalThis.localStorage;
        const values = new Map();
        const fakeStorage = {
          get length() { return values.size; },
          key(index) { return Array.from(values.keys())[index] || null; },
          getItem(key) { return values.has(key) ? values.get(key) : null; },
          setItem(key, value) { values.set(String(key), String(value)); },
          removeItem(key) { values.delete(String(key)); },
        };
        Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
        try {
          const repository = new PT.Repository();
          repository.mode = "memory";
          const project = sampleProject("ja");
          project.assets.push({ id: "keep", name: "keep.txt", type: "text/plain", size: 3, data: new Blob(["abc"]) });
          const saved = await repository.saveProject(project);
          const live = await repository.getProject(saved.id);
          live.title = "終了直前の変更";
          live.assets[0].caption = "終了直前の説明";
          live.assets[0].target = "results";
          assert(repository.saveEmergencyProject(live), "emergency draft was not written");
          equal(await repository.recoverEmergencyProjects(), 1, "recovered draft count");
          const recovered = await repository.getProject(saved.id);
          equal(recovered.title, "終了直前の変更", "unsaved title was not recovered");
          assert(recovered.assets[0].data instanceof Blob, "stored attachment was not preserved");
          equal(recovered.assets[0].caption, "終了直前の説明", "unsaved asset metadata was not recovered");
          equal(recovered.assets[0].target, "results", "unsaved asset target was not recovered");
        } finally {
          if (originalStorage === undefined) delete globalThis.localStorage;
          else Object.defineProperty(globalThis, "localStorage", { value: originalStorage, configurable: true, writable: true });
        }
      },
    },
    {
      name: "簡易保存モードは同一タブ内で添付Blobを保持する",
      run: async () => {
        const originalStorage = globalThis.localStorage;
        const values = new Map();
        const fakeStorage = {
          get length() { return values.size; },
          key(index) { return Array.from(values.keys())[index] || null; },
          getItem(key) { return values.has(key) ? values.get(key) : null; },
          setItem(key, value) { values.set(String(key), String(value)); },
          removeItem(key) { values.delete(String(key)); },
        };
        Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
        try {
          const repository = new PT.Repository();
          repository.mode = "localstorage";
          const project = sampleProject("ja");
          project.assets.push({ id: "overlay", name: "overlay.txt", type: "text/plain", size: 3, data: new Blob(["abc"]) });
          const saved = await repository.saveProject(project);
          const loaded = await repository.getProject(saved.id);
          assert(loaded.assets[0].data instanceof Blob, "same-tab Blob overlay was lost");
          equal((await repository.listProjects())[0].assets[0].data.size, 3, "list overlay size");
        } finally {
          if (originalStorage === undefined) delete globalThis.localStorage;
          else Object.defineProperty(globalThis, "localStorage", { value: originalStorage, configurable: true, writable: true });
        }
      },
    },
    {
      name: "Typstの引用は本文だけで保持しコメント化を防ぐ",
      run: () => {
        const literal = PT.escapeTypst("Title @home // private \ue0000\ue001");
        assert(literal.includes("\\@home"), "metadata citation marker was not escaped");
        assert(literal.includes("\\/\\/"), "Typst line comment was not escaped");
        assert(!literal.includes("undefined"), "user text collided with an internal sentinel");
        const prose = PT.escapeTypstProse("See @verified2026; mail a@b.com // note");
        assert(prose.includes("@verified2026"), "verified citation was escaped in prose");
        assert(prose.includes("a\\@b.com"), "email address was interpreted as a citation");
        assert(prose.includes("\\/\\/"), "prose comment marker was not escaped");
      },
    },
    {
      name: "文末の句点を引用キーへ取り込まない",
      run: () => {
        const project = sampleProject("en");
        project.manuscript = Object.assign({}, project.manuscript, PT.generateManuscript(project));
        project.manuscript.sections[0].content = "This follows prior work @verified2026.";
        const advice = PT.analyzeProject(project, project.manuscript);
        assert(!advice.some((item) => item.id === "references.unknown.verified2026."), "sentence period became part of citation key");
        assert(PT.renderTypst(project).includes("@verified2026."), "citation and sentence period missing from Typst output");
        const printHtml = PT.projectToPrintHtml(project);
        assert(printHtml.includes('<span class="citation">[1]</span>.'), "print citation was not resolved to its reference number");
        assert(!printHtml.includes("@verified2026"), "raw citation key leaked into print output");
      },
    },
    {
      name: "参考文献の文字列著者とISO日付を正しく出力する",
      run: () => {
        const project = sampleProject("ja");
        project.references[0].authors = "山田太郎、鈴木花子";
        project.references[0].year = "2024-02-29";
        const yaml = PT.renderReferencesYaml(project);
        equal((yaml.match(/^    - /gm) || []).length, 2, "author count");
        assert(yaml.includes("date: 2024-02-29"), "valid ISO date missing");
        assert(PT.renderBibtex(project).includes("山田太郎 and 鈴木花子"), "BibTeX authors were not separated");
        equal(PT.normalizeReferenceDate("2023-02-29"), "", "invalid calendar date accepted");
      },
    },
    {
      name: "不正な文献日付を出力せず助言する",
      run: () => {
        const project = sampleProject("ja");
        project.references[0].year = "2026年";
        assert(!PT.renderReferencesYaml(project).includes("date:"), "invalid date reached Hayagriva YAML");
        assert(PT.analyzeProject(project).some((item) => item.id === "references.date.0"), "invalid date advice missing");
      },
    },
    {
      name: "正規化後に重複する引用キーを拒否する",
      run: () => {
        const project = sampleProject("ja");
        project.references.push(Object.assign({}, project.references[0], { id: "ref_2", key: "verified 2026" }));
        project.references[0].key = "verified-2026";
        let rejected = false;
        try {
          PT.renderReferencesYaml(project);
        } catch (_error) {
          rejected = true;
        }
        assert(rejected, "duplicate normalized citation keys were accepted");
      },
    },
    {
      name: "概要と参考文献を重複せず全登録文献をTypstへ出す",
      run: () => {
        const project = sampleProject("ja");
        project.abstract = "検証済みの概要";
        project.manuscript = Object.assign({}, project.manuscript, PT.generateManuscript(project));
        const typst = PT.renderTypst(project);
        equal((typst.match(/^= 概要$/gm) || []).length, 1, "Typst abstract heading count");
        equal((typst.match(/#bibliography\("references\.yml", full: true\)/g) || []).length, 1, "Typst bibliography count");
        const html = PT.projectToPrintHtml(project);
        equal((html.match(/<h2>概要<\/h2>/g) || []).length, 1, "print abstract heading count");
        equal((html.match(/<h2>参考文献<\/h2>/g) || []).length, 1, "print references heading count");
      },
    },
    {
      name: "ZIPを展開して添付ファイルまで往復できる",
      run: async () => {
        const project = sampleProject("ja");
        project.assets.push({ id: "asset_1", name: "測定値.txt", type: "text/plain", size: 3, data: new Blob(["abc"]) });
        const archive = await PT.createProjectArchive(project);
        const entries = await PT.extractZip(archive, { maxBytes: PT.MAX_BACKUP_BYTES, maxEntries: PT.MAX_BACKUP_ENTRIES });
        const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
        equal(manifest.format, "paper-tools-project-archive", "manifest format");
        equal(manifest.assets.length, 1, "manifest asset count");
        equal(new TextDecoder().decode(entries[manifest.assets[0].path]), "abc", "asset round-trip");
      },
    },
    {
      name: "添付本体がない不完全なZIPを作らない",
      run: async () => {
        const project = sampleProject("ja");
        project.assets.push({ id: "missing", name: "missing.csv", type: "text/csv", size: 10, data: null });
        let rejected = false;
        try {
          await PT.createProjectArchive(project);
        } catch (_error) {
          rejected = true;
        }
        assert(rejected, "archive silently skipped a missing attachment");
      },
    },
    {
      name: "JSONから全添付ペイロード別名を除外する",
      run: () => {
        const project = sampleProject("ja");
        project.assets = [{ id: "legacy", name: "legacy.txt", content: "SECRET-CONTENT", bytes: new Uint8Array([1, 2, 3]) }];
        const serialized = PT.serializeProject(project);
        const restoredMetadata = JSON.parse(serialized).assets[0];
        assert(!serialized.includes("SECRET-CONTENT"), "legacy content leaked into JSON");
        assert(!Object.prototype.hasOwnProperty.call(restoredMetadata, "content") && !Object.prototype.hasOwnProperty.call(restoredMetadata, "bytes"), "binary alias remained in JSON asset metadata");
      },
    },
    {
      name: "書出しと読込みで同じサイズ・件数上限を使う",
      run: async () => {
        const originalBytes = PT.MAX_BACKUP_BYTES;
        const originalEntries = PT.MAX_BACKUP_ENTRIES;
        try {
          PT.MAX_BACKUP_BYTES = 256;
          let zipRejected = false;
          try {
            await PT.createZip([{ name: "large.txt", data: "x".repeat(300) }]);
          } catch (_error) {
            zipRejected = true;
          }
          assert(zipRejected, "oversized ZIP was created");
          let jsonRejected = false;
          try {
            PT.serializeProject({ title: "x".repeat(300) });
          } catch (_error) {
            jsonRejected = true;
          }
          assert(jsonRejected, "oversized JSON was created");
          PT.MAX_BACKUP_BYTES = 10000;
          PT.MAX_BACKUP_ENTRIES = 2;
          let entriesRejected = false;
          try {
            await PT.createZip([{ name: "a", data: "" }, { name: "b", data: "" }, { name: "c", data: "" }]);
          } catch (_error) {
            entriesRejected = true;
          }
          assert(entriesRejected, "ZIP with too many entries was created");
        } finally {
          PT.MAX_BACKUP_BYTES = originalBytes;
          PT.MAX_BACKUP_ENTRIES = originalEntries;
        }
      },
    },
    {
      name: "長いファイル名でも拡張子を保持する",
      run: () => {
        const name = PT.safeFilename("a".repeat(260) + ".png", "image.png");
        assert(name.endsWith(".png"), "extension was truncated");
        assert(name.length <= 180, "filename limit exceeded");
      },
    },
    {
      name: "添付の表示名を変えても内部ファイル拡張子を保持する",
      run: () => {
        const project = sampleProject("ja");
        project.assets.push({ id: "display", name: "figure.png", displayName: "システム構成図", type: "image/png", size: 3, caption: "", role: "figure", target: "results-discussion", data: new Blob(["png"]) });
        const normalized = PT.normalizeProject(project);
        equal(normalized.assets[0].name, "figure.png", "internal filename changed");
        equal(normalized.assets[0].displayName, "システム構成図", "display name was lost");
      },
    },
    {
      name: "Windowsの予約デバイス名を安全なファイル名へ変換する",
      run: () => {
        ["CON.txt", "AUX.png", "NUL", "COM1.csv", "LPT9.txt"].forEach((name) => {
          const safe = PT.safeFilename(name, "asset");
          assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe), `reserved name remained: ${safe}`);
        });
      },
    },
    {
      name: "メールアドレスを未知の引用として警告しない",
      run: () => {
        const project = sampleProject("en");
        project.research.notes = "Contact alice@example.com for the recorded protocol.";
        const advice = PT.analyzeProject(project, PT.generateManuscript(project));
        assert(!advice.some((item) => item.id === "references.unknown.example.com"), "email domain was treated as a citation");
      },
    },
    {
      name: "BibTeXの複数文献・ネスト波括弧・quoted値を解析する",
      run: () => {
        const source = [
          '@string{journalName = "Ignored Journal"}',
          "@comment{ignored {nested} comment}",
          '@preamble{"ignored preamble"}',
          "@article{Smith 2024,",
          "  title = {A {Nested {Title}} for Testing},",
          '  author = "Alice Smith and Bob Jones",',
          "  year = 2024,",
          "  journal = {Journal of {Safe} Systems},",
          "  doi = {10.1000/example},",
          '  url = "https://example.test/paper",',
          "  note = {Line {one} with \\{literal\\}",
          "          line two}",
          "}",
          "@inproceedings(Second-Key,",
          '  title = "Quoted " # "{Conference} Paper",',
          "  author = {Carol Example},",
          "  year = {2025},",
          "  booktitle = {Proceedings of Test},",
          ")",
        ].join("\n");
        const references = PT.parseBibtex(source);
        equal(references.length, 2, "parsed reference count");
        equal(Object.keys(references[0]).join(","), "key,type,title,authors,year,venue,doi,url,note", "reference shape");
        equal(references[0].key, "Smith-2024", "normalized citation key");
        equal(references[0].type, "article", "entry type");
        equal(references[0].title, "A Nested Title for Testing", "nested title");
        equal(references[0].authors, "Alice Smith and Bob Jones", "quoted author value");
        equal(references[0].year, "2024", "bare year value");
        equal(references[0].venue, "Journal of Safe Systems", "journal mapping");
        equal(references[0].note, "Line one with \\{literal\\} line two", "group braces and escaped braces");
        equal(references[1].title, "Quoted Conference Paper", "concatenated quoted value");
        equal(references[1].venue, "Proceedings of Test", "booktitle mapping");
      },
    },
    {
      name: "BibTeXの保護用波括弧を除去して書出し往復できる",
      run: () => {
        const parsed = PT.parseBibtex("@article{nasa, title={{NASA} Study}, author={{NASA} Team}, year={2024}, journal={{Space} Review}}");
        equal(parsed[0].title, "NASA Study", "protected title display");
        equal(parsed[0].authors, "NASA Team", "protected author display");
        equal(parsed[0].venue, "Space Review", "protected venue display");
        const restored = PT.parseBibtex(PT.renderBibtex({ references: parsed }));
        equal(JSON.stringify(restored), JSON.stringify(parsed), "BibTeX parse/export round-trip");
      },
    },
    {
      name: "BibTeXの代表的なTeXアクセントと特殊文字をUnicode化する",
      run: () => {
        const parsed = PT.parseBibtex(String.raw`@article{accent,
          title = {M{\"u}ller, Garc{\'i}a, \v{S}koda, and {\AA}ngstr{\"o}m},
          author = {Fran\c{c}ois L{\oe}we and {\AE}gir},
          year = {2024}
        }`);
        equal(parsed[0].title, "Müller, García, Škoda, and Ångström", "accented title");
        equal(parsed[0].authors, "François Lœwe and Ægir", "accented authors");
      },
    },
    {
      name: "BibTeXの@string macroを安全に展開し未定義名を保持する",
      run: () => {
        const source = [
          '@string{org = "{Robotics} Society"}',
          '@string{journalName = "Journal of " # org}',
          '@article{macro, title = prefix # ": " # "{Study}", year = publicationYear, journal = JOURNALNAME}',
          '@string{prefix = "Safe"}',
          '@string{publicationYear = "2026"}',
          '@misc{undefined, title = missingMacro, year = 2025}',
        ].join("\n");
        const parsed = PT.parseBibtex(source);
        equal(parsed[0].title, "Safe: Study", "forward macro concatenation");
        equal(parsed[0].venue, "Journal of Robotics Society", "case-insensitive nested macro");
        equal(parsed[0].year, "2026", "forward year macro");
        equal(parsed[1].title, "missingMacro", "undefined macro preservation");
      },
    },
    {
      name: "BibTeXの循環@string macroを拒否する",
      run: () => {
        let rejected = false;
        try {
          PT.parseBibtex("@string{first = second}\n@string{second = first}\n@misc{cycle, title = first}");
        } catch (error) {
          rejected = /Circular BibTeX @string macro/.test(error.message);
        }
        assert(rejected, "circular macros were accepted");
      },
    },
    {
      name: "BibTeXの正規化後に重複する引用キーを拒否する",
      run: () => {
        let rejected = false;
        try {
          PT.parseBibtex("@misc{same key, title={First}}\n@misc{same-key, title={Second}}");
        } catch (error) {
          rejected = /Duplicate citation key/.test(error.message);
        }
        assert(rejected, "duplicate normalized citation keys were accepted");
      },
    },
    {
      name: "BibTeXの不正な波括弧と入力上限を拒否する",
      run: () => {
        let malformedRejected = false;
        try {
          PT.parseBibtex("@article{broken, title={Unclosed}");
        } catch (error) {
          malformedRejected = error instanceof SyntaxError;
        }
        assert(malformedRejected, "unterminated entry was accepted");

        const originalLimit = PT.MAX_BIBTEX_BYTES;
        try {
          PT.MAX_BIBTEX_BYTES = 32;
          let oversizedRejected = false;
          try {
            PT.parseBibtex("@misc{key,title={" + "あ".repeat(20) + "}}");
          } catch (error) {
            oversizedRejected = error instanceof RangeError;
          }
          assert(oversizedRejected, "oversized BibTeX input was accepted");
        } finally {
          PT.MAX_BIBTEX_BYTES = originalLimit;
        }
      },
    },
    {
      name: "2段組テンプレートと対象節の図をTypstへ反映する",
      run: () => {
        const project = PT.createProject("engineering-two-column", { title: "二段組テスト" });
        project.references = sampleProject("ja").references;
        project.assets.push({ id: "fig_1", name: "result.png", type: "image/png", size: 3, caption: "結果図 @verified2026", role: "figure", target: "results", source: "", origin: "self", data: new Blob(["png"]) });
        project.manuscript = Object.assign({}, project.manuscript, PT.generateManuscript(project));
        const typst = PT.renderTypst(project);
        assert(typst.includes("#columns(2, gutter: 1.2em)["), "two-column layout missing");
        assert(typst.includes('#figure(image("assets/result.png"'), "targeted figure missing");
        equal((typst.match(/assets\/result\.png/g) || []).length, 1, "figure was repeated across sections");
        const printHtml = PT.projectToPrintHtml(project, new Map([["fig_1", "data:image/png;base64,YWJj"]]));
        assert(printHtml.includes('class="two-column"'), "print layout is not two-column");
        assert(printHtml.includes("<img") && printHtml.includes("結果図"), "print figure or caption missing");
        assert(printHtml.includes('<figcaption>結果図 <span class="citation">[1]</span></figcaption>'), "figure citation was not numbered");
        assert(printHtml.indexOf("<h2>概要</h2>") < printHtml.indexOf('<div class="paper-sections">'), "abstract was placed inside print columns");
      },
    },
    {
      name: "削除済み参考文献と追加セクションを再生成時に安全に扱う",
      run: () => {
        const project = sampleProject("ja");
        project.manuscript = Object.assign({}, project.manuscript, PT.generateManuscript(project));
        assert(project.manuscript.sections.find((section) => section.id === "references").content.includes("Verified Reference"), "reference fixture missing");
        project.references = [];
        project.manuscript.sections.push({ id: "appendix", title: "付録", content: "保持すべき追試条件", updatedAt: PT.nowIso() });
        const regenerated = PT.generateManuscript(project);
        const appendix = regenerated.sections.find((section) => section.id === "appendix");
        assert(appendix && appendix.content === "保持すべき追試条件", "custom section content was lost");
        project.manuscript = Object.assign({}, project.manuscript, regenerated);
        const typst = PT.renderTypst(project);
        assert(!typst.includes("Verified Reference"), "deleted reference was resurrected");
        assert(typst.includes("保持すべき追試条件"), "custom section missing from export");
      },
    },
    {
      name: "BibTeX文献種別をHayagriva互換へ変換する",
      run: () => {
        const project = { references: [
          { key: "phd", type: "phdthesis", title: "Thesis", venue: "Example University" },
          { key: "report", type: "techreport", title: "Report", venue: "Example Institute" },
          { key: "chapter", type: "inbook", title: "Chapter", venue: "Collected Work" },
          { key: "conference", type: "inproceedings", title: "Paper", venue: "Proceedings of X" },
          { key: "book", type: "book", title: "Book", venue: "Example Press" },
        ] };
        const yaml = PT.renderReferencesYaml(project);
        assert(yaml.includes("type: \"thesis\"") && yaml.includes("type: \"report\"") && yaml.includes("type: \"chapter\""), "Hayagriva aliases missing");
        assert(yaml.includes("organization: \"Example University\"") && yaml.includes("organization: \"Example Institute\""), "organization mapping missing");
        assert(yaml.includes("type: \"proceedings\"") && yaml.includes("title: \"Proceedings of X\""), "proceedings parent missing");
        assert(yaml.includes("publisher: \"Example Press\""), "book publisher mapping missing");
      },
    },
    {
      name: "図表の対象節と引用出典を検査する",
      run: () => {
        const project = sampleProject("ja");
        project.assets.push({ id: "fig_1", name: "cited.svg", type: "image/svg+xml", size: 3, caption: "", role: "figure", target: "", source: "", origin: "cited", data: new Blob(["svg"]) });
        const ids = PT.analyzeProject(project).map((item) => item.id);
        assert(ids.includes("assets.target.0"), "missing target advice");
        assert(ids.includes("assets.caption.0"), "missing caption advice");
        assert(ids.includes("assets.source.0"), "missing cited-source advice");
        project.assets[0].target = "removed-section";
        assert(PT.analyzeProject(project).some((item) => item.id === "assets.target.0"), "orphan target was not reported");
      },
    },
    {
      name: "参考文献の著者配列と著者メタデータを保持する",
      run: () => {
        const project = sampleProject("en");
        project.authors[0].orcid = "0000-0001-2345-6789";
        project.authors[0].corresponding = true;
        project.references[0].authors = ["Alice Example", "Bob Example"];
        const normalized = PT.normalizeProject(project);
        assert(Array.isArray(normalized.references[0].authors), "reference author array was flattened");
        equal(normalized.references[0].authors.length, 2, "reference author array length");
        assert(normalized.authors[0].corresponding, "corresponding-author flag was lost");
        assert(PT.renderReferencesYaml(normalized).match(/^    - /gm).length === 2, "YAML author count");
        assert(PT.renderTypst(normalized).includes("ORCID: 0000-0001-2345-6789"), "ORCID missing from Typst");
      },
    },
  ];

  async function run(report) {
    const results = [];
    for (const test of tests) {
      const started = Date.now();
      try {
        await test.run();
        const result = { name: test.name, ok: true, durationMs: Date.now() - started };
        results.push(result);
        if (report) report(result);
      } catch (error) {
        const result = { name: test.name, ok: false, error, durationMs: Date.now() - started };
        results.push(result);
        if (report) report(result);
      }
    }
    return results;
  }

  return { tests, run };
});
