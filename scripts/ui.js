(function (root) {
  "use strict";

  const PT = root.PaperTools;
  if (!PT) throw new Error("paper_tools のコアを読み込めませんでした．");

  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach((item) => append(parent, item));
    } else if (child instanceof root.Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }

  function h(tag, props) {
    const element = document.createElement(tag);
    const options = props || {};
    for (const [key, value] of Object.entries(options)) {
      if (value == null || value === false) continue;
      if (key === "className") element.className = value;
      else if (key === "text") element.textContent = String(value);
      else if (key === "dataset") Object.assign(element.dataset, value);
      else if (key === "style") Object.assign(element.style, value);
      else if (key === "on") {
        for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
      } else if (key in element && !key.startsWith("aria")) {
        try {
          element[key] = value;
        } catch (_error) {
          element.setAttribute(key, String(value));
        }
      } else {
        element.setAttribute(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), String(value));
      }
    }
    for (let index = 2; index < arguments.length; index += 1) append(element, arguments[index]);
    return element;
  }

  function button(label, className, onClick, attrs) {
    return h(
      "button",
      Object.assign(
        {
          type: "button",
          className: className || "button-secondary",
          text: label,
          on: { click: onClick },
        },
        attrs || {},
      ),
    );
  }

  function field(label, control, help) {
    const wrapper = h("div", { className: "form-field" });
    if (control.id) wrapper.appendChild(h("label", { htmlFor: control.id, text: label }));
    else wrapper.appendChild(h("span", { className: "form-label", text: label }));
    wrapper.appendChild(control);
    if (help) wrapper.appendChild(h("span", { className: "field-help", text: help }));
    return wrapper;
  }

  function textarea(id, value, placeholder, onInput) {
    return h("textarea", {
      id,
      className: "text-area",
      value: value || "",
      placeholder: placeholder || "",
      on: onInput ? { input: onInput } : undefined,
    });
  }

  function emptyState(title, message, actionLabel, onAction) {
    return h(
      "section",
      { className: "empty-state" },
      h("h2", { text: title }),
      h("p", { text: message }),
      actionLabel ? button(actionLabel, "button", onAction) : null,
    );
  }

  class PaperToolsApp {
    constructor() {
      this.main = document.getElementById("main-content");
      this.contextActions = document.getElementById("context-actions");
      this.storageStatus = document.getElementById("storage-status");
      this.storageDot = document.getElementById("storage-dot");
      this.saveState = document.getElementById("save-state");
      this.sidebar = document.getElementById("sidebar");
      this.dialog = document.getElementById("app-dialog");
      this.dialogTitle = document.getElementById("dialog-title");
      this.dialogBody = document.getElementById("dialog-body");
      this.dialogActions = document.getElementById("dialog-actions");
      this.importInput = document.getElementById("project-import-input");
      this.templateImportInput = document.getElementById("template-import-input");
      this.repo = new PT.Repository();
      this.projects = [];
      this.settings = Object.assign({}, PT.DEFAULT_SETTINGS);
      this.currentProject = null;
      this.wizardDraft = null;
      this.wizardStep = 1;
      this.editorMode = "content";
      this.inspectorTab = "advice";
      this.isRendering = false;
      this.rerenderRequested = false;
      this.deletedProjectIds = new Set();
      this.staleProjectObjects = new WeakSet();
      this.pendingSaves = new Map();
      this.dirtyProjects = new Map();
      this.inFlightSaves = new Set();
      this.saveRevision = 0;
      this.lastRenderedHash = root.location.hash || "#home";
      this.wizardSaveTimer = null;
      this.wizardSavePromise = null;
      this.wizardRevision = 0;
      this.wizardDirty = false;
      this.wizardFinishing = false;
      this.templateMutationInFlight = false;
    }

    async init() {
      this.bindShell();
      await this.repo.init();
      this.settings = await this.repo.getSettings();
      this.registerStoredCustomTemplates();
      const recoveredCount = await this.repo.recoverEmergencyProjects();
      await this.refreshProjects();
      this.storageDot.classList.add(this.repo.mode === "indexeddb" ? "is-ready" : "is-warning");
      this.storageStatus.textContent =
        this.repo.mode === "indexeddb"
          ? "このブラウザに自動保存"
          : this.repo.mode === "localstorage"
            ? "簡易保存モード"
            : "一時利用モード";
      if (recoveredCount) this.toast(`${recoveredCount}件の終了直前の編集を回復しました．`);
      await this.renderRoute();
    }

    registerStoredCustomTemplates() {
      const stored = Array.isArray(this.settings.customTemplates) ? this.settings.customTemplates.slice(0, 20) : [];
      const accepted = [];
      stored.forEach((item) => {
        try {
          const normalized = PT.normalizeTemplateDefinition(item);
          if (!normalized) return;
          accepted.push(PT.registerCustomTemplate(normalized));
        } catch (_error) {
          // 壊れた定義だけを無視し，組込みテンプレートと他の登録内容は利用可能にする．
        }
      });
      this.settings.customTemplates = accepted.map((item) => PT.normalizeTemplateDefinition(item));
    }

    bindShell() {
      root.addEventListener("hashchange", () => this.renderRoute());
      root.addEventListener("pagehide", () => {
        this.persistEmergencyDrafts();
        this.flushPendingSaves();
      });
      root.addEventListener("beforeunload", () => this.persistEmergencyDrafts());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.persistEmergencyDrafts();
          this.flushPendingSaves();
        }
      });
      document.getElementById("sidebar-toggle").addEventListener("click", () => {
        this.sidebar.classList.toggle("is-open");
      });
      document.querySelectorAll("[data-nav]").forEach((link) => {
        link.addEventListener("click", () => this.sidebar.classList.remove("is-open"));
      });
      document.getElementById("open-guide").addEventListener("click", () => this.showGuide());
      this.importInput.addEventListener("change", (event) => this.importProject(event));
      this.templateImportInput.addEventListener("change", (event) => this.importCustomTemplate(event));
      document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (this.currentProject) this.saveCurrentProject(true);
        }
      });
    }

    async refreshProjects() {
      this.projects = await this.repo.listProjects();
    }

    route() {
      const raw = root.location.hash.replace(/^#/, "") || "home";
      const parts = raw.split("/");
      const name = parts.shift();
      try {
        return {
          name,
          id: parts[0] ? decodeURIComponent(parts[0]) : "",
          step: parts[1] ? decodeURIComponent(parts[1]) : "",
        };
      } catch (_error) {
        return { name: "home", id: "", step: "" };
      }
    }

    navigate(route) {
      const target = `#${String(route).replace(/^#/, "")}`;
      if (root.location.hash === target) this.renderRoute();
      else root.location.hash = target;
    }

    async copyText(value, control) {
      const text = String(value || "");
      if (!text) throw new Error("コピーする内容がありません．");
      try {
        if (root.navigator && root.navigator.clipboard && typeof root.navigator.clipboard.writeText === "function") {
          await root.navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_error) {
        // file:// ではClipboard APIが許可されない場合があるため，選択コピーへ切り替える．
      }
      if (control && typeof control.select === "function") {
        control.focus();
        control.select();
        if (typeof document.execCommand === "function" && document.execCommand("copy")) return true;
      }
      throw new Error("自動コピーできませんでした．表示されたプロンプトを選択してコピーしてください．");
    }

    async renderRoute() {
      if (this.isRendering) {
        this.rerenderRequested = true;
        return;
      }
      this.isRendering = true;
      try {
        do {
          this.rerenderRequested = false;
          const routeHash = root.location.hash;
          const savesCompleted = await this.flushPendingSaves();
          const wizardSaved = await this.flushWizardSave();
          if (!savesCompleted || !wizardSaved) {
            if (root.history && typeof root.history.replaceState === "function") {
              root.history.replaceState(null, "", this.lastRenderedHash);
            }
            if (this.currentProject) this.renderEditor();
            this.rerenderRequested = false;
            break;
          }
          this.sidebar.classList.remove("is-open");
          this.contextActions.replaceChildren();
          this.saveState.textContent = "";
          const route = this.route();
          document.querySelectorAll("[data-nav]").forEach((link) => {
            const active = link.dataset.nav === route.name || (route.name === "editor" && link.dataset.nav === "projects");
            if (active) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
          });
          try {
            if (route.name === "home") await this.renderHome();
            else if (route.name === "projects") await this.renderProjects();
            else if (route.name === "new") await this.renderWizard(route.id, route.step);
            else if (route.name === "templates") await this.renderTemplates();
            else if (route.name === "assistant") await this.renderAssistant(route.id);
            else if (route.name === "settings") this.renderSettings();
            else if (route.name === "editor") await this.openEditor(route.id);
            else this.navigate("home");
          } catch (error) {
            this.renderFatal(error);
          }
          this.lastRenderedHash = root.location.hash || "#home";
          if (root.location.hash !== routeHash) this.rerenderRequested = true;
        } while (this.rerenderRequested);
      } finally {
        this.isRendering = false;
        this.main.focus({ preventScroll: true });
      }
    }

    page(title, description, wide) {
      const page = h("div", { className: wide ? "page page--wide" : "page" });
      const heading = h(
        "header",
        { className: "page-heading" },
        h("div", {}, h("h1", { text: title }), description ? h("p", { text: description }) : null),
      );
      page.appendChild(heading);
      this.main.replaceChildren(page);
      return page;
    }

    async renderHome() {
      await this.refreshProjects();
      const page = h("div", { className: "page" });
      const hero = h(
        "section",
        { className: "hero-panel" },
        h(
          "div",
          {},
          h("h1", { text: "研究内容を，論文のかたちへ．" }),
          h("p", {
            text: "事実だけを入力すると，構成・草稿・不足情報を整理します．テンプレート解釈とAI向け指示文の作成まで，環境構築なしで使えます．",
          }),
          h(
            "div",
            { className: "button-row" },
            button("新しい論文を作る", "button", () => this.navigate("new")),
            button("保存済みを開く", "button-secondary", () => this.navigate("projects")),
          ),
        ),
        h(
          "div",
          { className: "hero-guide" },
          h("strong", { text: "基本の使い方は3段階" }),
          h(
            "ol",
            {},
            h("li", { text: "テンプレートを選ぶ" }),
            h("li", { text: "確認できている研究情報を入力する" }),
            h("li", { text: "草稿を編集し，PDFまたはTypstへ出力する" }),
          ),
        ),
      );
      page.appendChild(hero);
      if (this.repo.warning) {
        page.appendChild(
          h(
            "div",
            { className: "notice notice--warning", style: { marginTop: "18px" } },
            h("strong", { text: "保存について" }),
            h("p", { text: this.repo.warning }),
          ),
        );
      }
      const recentHeader = h(
        "div",
        { className: "section-heading" },
        h("div", {}, h("h2", { text: "最近のプロジェクト" }), h("p", { text: "最後に編集した順です．" })),
        this.projects.length ? button("すべて表示", "button-link", () => this.navigate("projects")) : null,
      );
      page.appendChild(recentHeader);
      if (!this.projects.length) {
        page.appendChild(
          emptyState(
            "まだプロジェクトがありません",
            "最初のプロジェクトは5つの短いステップで作成できます．",
            "新規作成を始める",
            () => this.navigate("new"),
          ),
        );
      } else {
        const grid = h("div", { className: "grid grid--three" });
        this.projects.slice(0, 3).forEach((project) => grid.appendChild(this.projectCard(project, true)));
        page.appendChild(grid);
      }
      const featureHeader = h("div", { className: "section-heading" }, h("div", {}, h("h2", { text: "このアプリでできること" })));
      page.appendChild(featureHeader);
      page.appendChild(
        h(
          "div",
          { className: "grid grid--three" },
          this.infoCard("テンプレートを自動解釈", "Markdown，Typst，LaTeXなどを選ぶだけで，見出し・言語・段組・必要項目を登録します．"),
          this.infoCard("外部APIなしで草稿化", "入力済みの内容だけを使い，不足部分は明示的なTODOとして残します．"),
          this.infoCard("図・データの不足を診断", "研究内容と原稿を照合し，追加すべき図，表，評価データを具体的に示します．"),
          this.infoCard("英文変換プロンプト", "日本語原稿を英語へ変換するための，捏造防止条件付きプロンプトを作成します．"),
          this.infoCard("模擬査読と内容補強", "査読，拡張，校正，文献調査をローカルLLMなどへ依頼する指示文を作成します．"),
          this.infoCard("持ち出せるデータ", "JSON，Typst，BibTeX，ZIPへ書き出せます．PDFはブラウザの印刷機能で保存します．"),
        ),
      );
      this.main.replaceChildren(page);
    }

    infoCard(title, text) {
      return h("article", { className: "card" }, h("h3", { text: title }), h("p", { text }));
    }

    projectCard(project, compact) {
      const completeness = PT.projectCompleteness(project);
      const unresolved = (project.manuscript.advice || []).filter((item) => !item.resolved).length;
      const unfinished = project.status === "draft" && !project.manuscript.generatedAt;
      const openRoute = unfinished
        ? `new/${encodeURIComponent(project.id)}/${project.ui.wizardStep || 1}`
        : `editor/${encodeURIComponent(project.id)}`;
      return h(
        "article",
        { className: "card" },
        h("div", { className: "card__meta" }, h("span", { className: "badge badge--accent", text: project.language === "en" ? "English" : "日本語" }), h("span", { text: `${completeness}% 入力済み` })),
        h("h2", { text: project.name, style: { marginTop: "12px", fontSize: compact ? "1.05rem" : "1.2rem" } }),
        h("p", { text: project.title || "論文タイトルは未入力です．" }),
        h("div", { className: "card__meta" }, h("span", { text: `更新 ${PT.formatDate(project.updatedAt, project.language)}` }), h("span", { text: `未解決 ${unresolved}件` })),
        h(
          "div",
          { className: "card__actions" },
          button(unfinished ? "作成を続ける" : "開く", "button", () => this.navigate(openRoute)),
          compact ? null : button("複製", "button-secondary", () => this.duplicateProject(project.id)),
          compact ? null : button("本文JSON", "button-quiet", () => this.downloadJson(project)),
          compact ? null : button("削除", "button-quiet", () => this.deleteProject(project)),
        ),
      );
    }

    async renderProjects() {
      await this.refreshProjects();
      const page = this.page("プロジェクト", "このブラウザに保存されている論文を管理します．");
      page.querySelector(".page-heading").appendChild(
        h(
          "div",
          { className: "button-row" },
          button("バックアップを読み込む", "button-secondary", () => this.importInput.click()),
          button("新規作成", "button", () => this.navigate("new")),
        ),
      );
      if (!this.projects.length) {
        page.appendChild(emptyState("保存済みプロジェクトはありません", "JSONまたはZIPバックアップを読み込むか，新しく作成してください．", "新規作成", () => this.navigate("new")));
        return;
      }
      const grid = h("div", { className: "grid grid--two" });
      this.projects.forEach((project) => grid.appendChild(this.projectCard(project, false)));
      page.appendChild(grid);
    }

    async renderTemplates() {
      const page = this.page("テンプレート", "組込み構成を選ぶか，手元のテンプレートファイルをアップロードするだけで登録できます．");
      const customCount = typeof PT.listCustomTemplates === "function" ? PT.listCustomTemplates().length : 0;
      page.appendChild(h("section", { className: "panel template-import-panel" },
        h("div", { className: "section-heading", style: { marginTop: "0" } },
          h("div", {}, h("h2", { text: "テンプレートを自動登録" }), h("p", { text: "見出し，言語，段組，必要な研究情報を自動解釈します．" })),
          button("ファイルを選んで登録", "button", () => this.templateImportInput.click()),
        ),
        h("p", { text: "対応：JSON，Markdown，TXT，Typst，LaTeX，HTML（最大512 KiB）．選択後に自動登録され，元ファイルやHTMLコードは保存しません．" }),
        h("div", { className: "notice notice--warning" }, h("p", { text: "PDFとDOCXは，ブラウザーだけで構造を正確に解釈できないため登録対象外です．テキスト形式へ変換してアップロードしてください．" })),
        h("p", { className: "field-help", text: `現在の登録：組込み ${PT.BUILT_IN_TEMPLATE_IDS.length}件・カスタム ${customCount}件` }),
      ));
      const filter = h("select", { id: "template-language", className: "select-input" }, h("option", { value: "all", text: "すべての言語" }), h("option", { value: "ja", text: "日本語" }), h("option", { value: "en", text: "English" }));
      const filterBar = h("div", { className: "filter-bar" }, field("言語", filter));
      const grid = h("div", { className: "grid grid--three" });
      const draw = () => {
        grid.replaceChildren();
        PT.TEMPLATES.filter((template) => filter.value === "all" || (template.languages || [template.language]).includes(filter.value)).forEach((template) => {
          const supportedLanguages = template.languages || [template.language];
          const previewLanguage = filter.value === "en" ? "en" : template.language;
          grid.appendChild(
            h(
              "article",
              { className: "card template-card" },
              h("div", { className: "card__meta" }, h("span", { className: "badge badge--accent", text: supportedLanguages.length > 1 ? "日本語 / English" : template.language === "en" ? "English" : "日本語" }), h("span", { text: template.isCustom ? "自動解釈" : template.typeLabel || template.type })),
              h("h2", { text: template.name, style: { marginTop: "12px", fontSize: "1.08rem" } }),
              h("p", { text: template.description }),
              h("ol", { className: "template-sections" }, template.sections.slice(0, 6).map((section) => h("li", { text: previewLanguage === "en" ? section.titleEn || section.title : section.titleJa || section.title }))),
              template.isCustom && template.interpretation && Array.isArray(template.interpretation.warnings) && template.interpretation.warnings.length
                ? h("div", { className: "template-interpretation-note" },
                  h("strong", { text: "自動解釈の確認事項" }),
                  h("ul", {}, template.interpretation.warnings.slice(0, 20).map((warning) => h("li", { text: warning }))),
                )
                : null,
              template.isCustom ? h("p", { className: "field-help", text: `元ファイル：${template.source.filename || "不明"}／${template.layout === "two-column" ? "2段組" : "1段組"}` }) : null,
              h("div", { className: "card__actions" }, button("この構成で作る", "button", () => this.startWizard(template.id)), template.isCustom ? button("登録を削除", "button-quiet", () => this.deleteCustomTemplate(template)) : null),
            ),
          );
        });
      };
      filter.addEventListener("change", draw);
      draw();
      page.append(filterBar, grid);
    }

    async importCustomTemplate(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      return this.runTemplateMutation(async () => {
        try {
          const result = await PT.analyzeCustomTemplateFile(file);
          if (!result.ok) {
            this.toast(result.message || "テンプレートを解釈できませんでした．", true);
            return;
          }
          const enriched = Object.assign({}, result.template, {
            source: Object.assign({}, result.template.source, { importedAt: PT.nowIso() }),
            interpretation: {
              confidence: result.analysis && result.analysis.usedFallbackOutline ? 0.55 : 0.9,
              warnings: result.warnings || [],
            },
          });
          const normalized = PT.normalizeTemplateDefinition(enriched);
          if (!normalized) throw new Error("安全なテンプレート定義を作成できませんでした．");
          const current = Array.isArray(this.settings.customTemplates) ? this.settings.customTemplates.slice() : [];
          const replacingExisting = current.some((item) => item.id === normalized.id);
          if (!replacingExisting && current.length >= 20) {
            throw new Error("カスタムテンプレートは20件まで登録できます．不要な登録を削除してから再度お試しください．");
          }
          const nextTemplates = current.filter((item) => item.id !== normalized.id);
          nextTemplates.push(normalized);
          const previousSettings = this.settings;
          const savedSettings = await this.repo.saveSettings(Object.assign({}, previousSettings, { customTemplates: nextTemplates }));
          let registered;
          try {
            registered = PT.registerCustomTemplate(normalized);
          } catch (registerError) {
            try {
              await this.repo.saveSettings(previousSettings);
            } catch (_rollbackError) {
              // 永続化の復旧にも失敗した場合は，次回起動時に保存済み定義から再登録される．
            }
            throw registerError;
          }
          this.settings = savedSettings;
          const warningText = result.warnings && result.warnings.length ? ` ${result.warnings.join(" ")}` : "";
          this.toast(`${registered.name}を登録しました（${registered.sections.length}節・${registered.layout === "two-column" ? "2段組" : "1段組"}）．${warningText}`);
          if (this.route().name === "templates") {
            try {
              await this.renderTemplates();
            } catch (renderError) {
              this.toast(`登録は完了しましたが，一覧を再表示できませんでした：${renderError.message}`, true);
            }
          }
        } catch (error) {
          this.toast(`テンプレートを登録できませんでした：${error.message}`, true);
        }
      });
    }

    async deleteCustomTemplate(template) {
      return this.runTemplateMutation(async () => {
        await this.refreshProjects();
        const usedBy = this.projects.filter((project) => project.templateId === template.id);
        if (usedBy.length) {
          this.toast(`このテンプレートは${usedBy.length}件のプロジェクトで使用中です．先に対象プロジェクトを整理してください．`, true);
          return;
        }
        const ok = await this.confirm("テンプレート登録を削除", `「${template.name}」をこのブラウザーの登録一覧から削除します．`, "削除する", true);
        if (!ok) return;
        const previousSettings = this.settings;
        const remaining = (Array.isArray(previousSettings.customTemplates) ? previousSettings.customTemplates : []).filter((item) => item.id !== template.id);
        let savedSettings;
        try {
          savedSettings = await this.repo.saveSettings(Object.assign({}, previousSettings, { customTemplates: remaining }));
        } catch (error) {
          this.toast(`テンプレート登録を削除できませんでした：${error.message}`, true);
          return;
        }
        if (!PT.unregisterCustomTemplate(template.id)) {
          try {
            await this.repo.saveSettings(previousSettings);
          } catch (_rollbackError) {
            this.toast("保存状態を復旧できませんでした．ページを再読み込みして登録一覧を確認してください．", true);
            return;
          }
          this.toast("テンプレート登録を削除できませんでした：登録一覧を更新できませんでした．", true);
          return;
        }
        this.settings = savedSettings;
        this.toast("テンプレート登録を削除しました．");
        try {
          await this.renderTemplates();
        } catch (renderError) {
          this.toast(`削除は完了しましたが，一覧を再表示できませんでした：${renderError.message}`, true);
        }
      });
    }

    async runTemplateMutation(action) {
      if (this.templateMutationInFlight) {
        this.toast("テンプレートを処理中です．完了してからもう一度操作してください．", true);
        return false;
      }
      this.templateMutationInFlight = true;
      try {
        return await action();
      } catch (error) {
        this.toast(`テンプレート処理を完了できませんでした：${error.message}`, true);
        return false;
      } finally {
        this.templateMutationInFlight = false;
      }
    }

    async startWizard(templateId) {
      this.wizardDraft = PT.createProject(templateId || "generic-ja");
      this.wizardDraft.englishVariant = this.settings.englishVariant === "british" ? "british" : "american";
      this.wizardStep = 1;
      this.wizardDraft.ui.wizardStep = 1;
      try {
        this.wizardDraft = await this.repo.saveProject(this.wizardDraft);
        this.navigate(`new/${encodeURIComponent(this.wizardDraft.id)}/1`);
      } catch (error) {
        this.toast(`下書きを開始できませんでした：${error.message}`, true);
      }
    }

    async renderWizard(identifier, requestedStep) {
      const selectedTemplate = PT.TEMPLATES.find((template) => template.id === identifier);
      const requestedProjectId = identifier && !selectedTemplate ? identifier : "";
      if (!this.wizardDraft || (requestedProjectId && this.wizardDraft.id !== requestedProjectId)) {
        this.wizardDraft = requestedProjectId ? await this.repo.getProject(requestedProjectId) : null;
        if (!this.wizardDraft) {
          this.wizardDraft = PT.createProject(selectedTemplate ? selectedTemplate.id : "generic-ja");
          this.wizardDraft.englishVariant = this.settings.englishVariant === "british" ? "british" : "american";
          this.wizardDraft = await this.repo.saveProject(this.wizardDraft);
          if (root.history && typeof root.history.replaceState === "function") {
            root.history.replaceState(null, "", `#new/${encodeURIComponent(this.wizardDraft.id)}/1`);
          }
        }
        this.wizardStep = this.wizardDraft.ui.wizardStep || 1;
      }
      const numericStep = Number(requestedStep);
      if (Number.isInteger(numericStep) && numericStep >= 1 && numericStep <= 5) this.wizardStep = numericStep;
      this.wizardDraft.ui.wizardStep = this.wizardStep;
      const stepNames = ["基本情報", "著者", "研究内容", "図・データ", "指示と確認"];
      const page = this.page("新しいプロジェクト", "確認できている情報だけを入力してください．空欄は後から補えます．");
      const steps = h("ol", { className: "step-list", ariaLabel: "作成ステップ" });
      stepNames.forEach((name, index) => {
        const item = h("li", { ariaCurrent: index + 1 === this.wizardStep ? "step" : undefined, className: index + 1 < this.wizardStep ? "is-done" : "" }, h("span", { className: "step-number", text: index + 1 < this.wizardStep ? "✓" : String(index + 1) }), h("span", { text: name }));
        steps.appendChild(item);
      });
      const panel = h("section", { className: "panel wizard-panel" });
      panel.appendChild(this.renderWizardStep());
      ["input", "change", "click"].forEach((eventName) => {
        panel.addEventListener(eventName, () => this.queueWizardSave());
      });
      page.appendChild(h("div", { className: "wizard-layout" }, steps, panel));
    }

    renderWizardStep() {
      const draft = this.wizardDraft;
      const fragment = document.createDocumentFragment();
      const headings = [
        ["基本情報", "論文の種類と言語を決めます．"],
        ["著者情報", "著者は後から追加・並べ替えできます．"],
        ["研究内容", "事実が確定していない欄は空白のままにしてください．"],
        ["図・表・データ", "対応ファイルはブラウザ内に保存され，ZIPへ含められます．"],
        ["詳細指示と確認", "文章の方針を指定し，ルールベースで最初の草稿を作ります．"],
      ];
      fragment.appendChild(h("div", { className: "wizard-panel__heading" }, h("h2", { text: `${this.wizardStep}. ${headings[this.wizardStep - 1][0]}` }), h("p", { text: headings[this.wizardStep - 1][1] })));
      if (this.wizardStep === 1) fragment.appendChild(this.wizardBasic());
      if (this.wizardStep === 2) fragment.appendChild(this.wizardAuthors());
      if (this.wizardStep === 3) fragment.appendChild(this.wizardResearch());
      if (this.wizardStep === 4) fragment.appendChild(this.wizardAssets());
      if (this.wizardStep === 5) fragment.appendChild(this.wizardInstructions());
      fragment.appendChild(
        h(
          "div",
          { className: "wizard-actions" },
          this.wizardStep > 1 ? button("戻る", "button-secondary", () => this.changeWizardStep(-1)) : h("span"),
          this.wizardStep < 5 ? button("保存して次へ", "button", () => this.changeWizardStep(1)) : button("草稿を作成する", "button", () => this.finishWizard()),
        ),
      );
      return fragment;
    }

    inputFor(label, id, value, onInput, options) {
      const opts = options || {};
      const control = opts.multiline
        ? textarea(id, value, opts.placeholder, onInput)
        : h("input", { id, className: "text-input", type: opts.type || "text", value: value || "", placeholder: opts.placeholder || "", required: opts.required || false, on: { input: onInput } });
      const wrapper = field(label, control, opts.help);
      if (opts.full) wrapper.classList.add("form-field--full");
      return wrapper;
    }

    documentTypeLabel(value) {
      const labels = { "research-paper": "研究論文", "journal-paper": "学術誌論文", "thesis-draft": "学位論文草稿", "conference-paper": "会議論文", "engineering-paper": "工学論文", "robotics-paper": "ロボティクス論文", "experiment-paper": "実験論文", "short-paper": "短報", "technical-note": "技術ノート", "literature-review": "文献レビュー", survey: "サーベイ", "research-proposal": "研究計画書", "grant-draft": "申請書草稿", "experiment-report": "実験報告書", "laboratory-report": "実験室レポート" };
      return labels[value] || value;
    }

    wizardBasic() {
      const draft = this.wizardDraft;
      const grid = h("div", { className: "form-grid" });
      grid.append(
        this.inputFor("プロジェクト名", "project-name", draft.name, (event) => { draft.name = PT.plainText(event.target.value, 200); }, { required: true, placeholder: "例：移動ロボット経路計画" }),
        this.inputFor("論文タイトル", "paper-title", draft.title, (event) => { draft.title = PT.plainText(event.target.value, 500); }, { required: true, placeholder: "仮題でも構いません" }),
      );
      const templateSelect = h("select", { id: "project-template", className: "select-input", value: draft.templateId, on: { change: (event) => this.replaceWizardTemplate(event.target.value) } }, PT.TEMPLATES.map((template) => h("option", { value: template.id, text: template.name, selected: template.id === draft.templateId })));
      const languageSelect = h("select", { id: "project-language", className: "select-input", value: draft.language, on: { change: (event) => { draft.language = event.target.value === "en" ? "en" : "ja"; } } }, h("option", { value: "ja", text: "日本語", selected: draft.language === "ja" }), h("option", { value: "en", text: "English", selected: draft.language === "en" }));
      const selectedTemplate = PT.templateMap[draft.templateId] || PT.TEMPLATES[0];
      const documentTypes = selectedTemplate.documentTypes || [selectedTemplate.type];
      if (!documentTypes.includes(draft.documentType)) draft.documentType = selectedTemplate.type;
      const documentTypeSelect = h("select", { id: "project-document-type", className: "select-input", on: { change: (event) => { draft.documentType = event.target.value; } } }, documentTypes.map((value) => h("option", { value, text: this.documentTypeLabel(value), selected: draft.documentType === value })));
      const englishVariant = h("select", { id: "project-english-variant", className: "select-input", on: { change: (event) => { draft.englishVariant = event.target.value === "british" ? "british" : "american"; } } }, h("option", { value: "american", text: "American English", selected: draft.englishVariant !== "british" }), h("option", { value: "british", text: "British English", selected: draft.englishVariant === "british" }));
      grid.append(field("テンプレート", templateSelect), field("出力言語", languageSelect), field("論文種別", documentTypeSelect), field("英語表記", englishVariant, "英語原稿のTypst地域設定へ反映します．"));
      grid.append(
        this.inputFor("研究分野", "paper-field", draft.field, (event) => { draft.field = PT.plainText(event.target.value, 300); }, { full: true, placeholder: "例：ロボティクス，制御工学" }),
        this.inputFor("ページ数の目安", "paper-pages", draft.pageTarget, (event) => { draft.pageTarget = PT.plainText(event.target.value, 40); }, { placeholder: "例：8ページ" }),
        this.inputFor("対象読者", "paper-audience", draft.targetAudience, (event) => { draft.targetAudience = PT.plainText(event.target.value, 1000); }, { placeholder: "例：制御工学の研究者" }),
        this.inputFor("投稿先メモ", "paper-submission", draft.submissionNotes, (event) => { draft.submissionNotes = PT.plainText(event.target.value, 5000); }, { multiline: true, full: true, placeholder: "投稿先，締切，書式上の注意" }),
      );
      return grid;
    }

    replaceWizardTemplate(templateId) {
      const previous = this.wizardDraft;
      const replacement = PT.createProject(templateId, previous);
      replacement.id = previous.id;
      replacement.createdAt = previous.createdAt;
      replacement.authors = previous.authors;
      replacement.research = previous.research;
      replacement.assets = previous.assets;
      const validTargets = new Set(replacement.manuscript.sections.map((section) => section.id));
      replacement.assets.forEach((asset) => {
        if (asset.target && !validTargets.has(asset.target)) asset.target = "";
      });
      replacement.references = previous.references;
      replacement.englishVariant = previous.englishVariant;
      const replacementTemplate = PT.templateMap[templateId];
      if (replacementTemplate && !(replacementTemplate.documentTypes || []).includes(replacement.documentType)) replacement.documentType = replacementTemplate.type;
      replacement.instructions = previous.instructions;
      replacement.keywords = previous.keywords;
      this.wizardDraft = replacement;
      this.queueWizardSave();
      this.navigate(`new/${encodeURIComponent(replacement.id)}/${this.wizardStep}`);
    }

    wizardAuthors() {
      const container = h("div");
      const list = h("div", { className: "repeater-list" });
      const draw = () => {
        list.replaceChildren();
        if (!this.wizardDraft.authors.length) list.appendChild(h("div", { className: "notice", text: "著者が未登録です．少なくとも氏名を1件追加してください．" }));
        this.wizardDraft.authors.forEach((author, index) => {
          list.appendChild(
            h(
              "div",
              { className: "repeater-row" },
              this.inputFor("氏名", `author-name-${index}`, author.name, (event) => { author.name = PT.plainText(event.target.value, 200); }),
              this.inputFor("所属", `author-affiliation-${index}`, author.affiliation, (event) => { author.affiliation = PT.plainText(event.target.value, 300); }),
              this.inputFor("メール", `author-email-${index}`, author.email, (event) => { author.email = PT.plainText(event.target.value, 320); }, { type: "email" }),
              this.inputFor("ORCID", `author-orcid-${index}`, author.orcid, (event) => { author.orcid = PT.plainText(event.target.value, 40); }, { placeholder: "0000-0000-0000-0000" }),
              h("label", { className: "check-option" }, h("input", { type: "checkbox", checked: Boolean(author.corresponding), on: { change: (event) => { author.corresponding = event.target.checked; } } }), h("span", { text: "連絡著者" })),
              h("div", { className: "button-row" }, button("↑", "button-quiet", () => { if (index > 0) { const moved = this.wizardDraft.authors.splice(index, 1)[0]; this.wizardDraft.authors.splice(index - 1, 0, moved); draw(); } }, { disabled: index === 0, ariaLabel: `${author.name || index + 1} を上へ` }), button("↓", "button-quiet", () => { if (index < this.wizardDraft.authors.length - 1) { const moved = this.wizardDraft.authors.splice(index, 1)[0]; this.wizardDraft.authors.splice(index + 1, 0, moved); draw(); } }, { disabled: index === this.wizardDraft.authors.length - 1, ariaLabel: `${author.name || index + 1} を下へ` })),
              button("削除", "button-quiet", () => { this.wizardDraft.authors.splice(index, 1); draw(); }, { ariaLabel: `${author.name || index + 1} を削除` }),
            ),
          );
        });
      };
      draw();
      container.append(list, button("著者を追加", "button-secondary", () => { this.wizardDraft.authors.push({ id: PT.makeId("author"), name: "", affiliation: "", email: "", orcid: "", corresponding: false }); draw(); }, { style: { marginTop: "14px" } }));
      return container;
    }

    wizardResearch() {
      const draft = this.wizardDraft;
      const r = draft.research;
      const mode = draft.ui.researchMode === "detail" ? "detail" : "simple";
      const selectMode = (nextMode) => {
        draft.ui.researchMode = nextMode;
        this.queueWizardSave();
        this.renderRoute();
      };
      const toggle = h(
        "div",
        { className: "segmented-control", ariaLabel: "研究内容の入力方法" },
        button("簡易入力", "", () => selectMode("simple"), { ariaPressed: mode === "simple" ? "true" : "false" }),
        button("詳細入力", "", () => selectMode("detail"), { ariaPressed: mode === "detail" ? "true" : "false" }),
      );
      const grid = h("div", { className: "form-grid" });
      const items = mode === "simple"
        ? [
            ["研究内容を自由に記述", "simpleDescription", "目的，対象，方法，結果など，分かっている範囲で記入してください"],
            ["箇条書きメモ", "bulletNotes", "1行に1項目ずつ入力できます"],
            ["研究で実現したこと", "achievements", "確認できている成果や観察事実"],
            ["最も伝えたい点", "keyMessage", "読者に持ち帰ってほしい要点"],
          ]
        : [
            ["研究目的", "objective", "何を明らかにする研究か"],
            ["背景", "background", "なぜこの研究が必要か"],
            ["新規性", "novelty", "既存研究との違い"],
            ["方法", "method", "提案手法・対象・手順"],
            ["実験・評価", "experimentalConditions", "条件，環境，試行回数，評価指標"],
            ["結果", "results", "確認済みの数値や観察事実"],
            ["考察", "discussion", "結果から言えることと言えないこと"],
            ["結論", "conclusion", "主要な知見と今後の課題"],
          ];
      items.forEach(([label, key, placeholder]) => grid.appendChild(this.inputFor(label, `research-${key}`, r[key], (event) => { r[key] = PT.plainText(event.target.value, 50000); }, { multiline: true, full: true, placeholder })));
      grid.appendChild(this.inputFor("キーワード", "research-keywords", draft.keywords.join("，"), (event) => { draft.keywords = event.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 30); }, { full: true, help: "読点またはカンマで区切ります．" }));
      const detailedGrid = h("div", { className: "form-grid" });
      [
        ["研究課題", "problem"],
        ["システム構成", "systemDesign"],
        ["実験条件", "experimentalConditions"],
        ["評価指標", "metrics"],
        ["比較対象", "comparison"],
        ["試行回数", "trialCount"],
        ["統計情報", "statistics"],
        ["文献検索手順", "searchStrategy"],
        ["分類基準", "classification"],
        ["研究上のギャップ", "researchGaps"],
        ["研究計画", "researchPlan"],
        ["期待結果", "expectedResults"],
        ["スケジュール", "schedule"],
        ["使用機器", "equipment"],
        ["限界", "limitations"],
        ["再現性", "reproducibility"],
        ["今後の課題", "futureWork"],
      ].forEach(([label, key]) => {
        detailedGrid.appendChild(
          this.inputFor(label, `research-${key}`, r[key], (event) => {
            r[key] = PT.plainText(event.target.value, 50000);
          }, { multiline: true, full: true }),
        );
      });
      return h(
        "div",
        {},
        toggle,
        h("p", { className: "field-help", text: mode === "simple" ? "この4項目だけでも，構成案と不足情報を作成できます．" : "必要な項目だけ入力してください．空欄は不足情報として明示されます．" }),
        grid,
        mode === "detail" ? h("details", { className: "details-panel" }, h("summary", { text: "さらに詳しい研究情報" }), detailedGrid) : null,
      );
    }

    wizardAssets() {
      const container = h("div");
      const input = h("input", { type: "file", multiple: true, accept: ".png,.jpg,.jpeg,.svg,.pdf,.csv,.json,.txt,.yaml,.yml", hidden: true, on: { change: (event) => this.addAssets(Array.from(event.target.files || []), draw) } });
      const zone = h("div", { className: "drop-zone", tabIndex: 0, role: "button", ariaLabel: "ファイルを追加", on: { click: () => input.click(), keydown: (event) => { if (event.key === "Enter" || event.key === " ") input.click(); }, dragover: (event) => { event.preventDefault(); zone.classList.add("is-dragging"); }, dragleave: () => zone.classList.remove("is-dragging"), drop: (event) => { event.preventDefault(); zone.classList.remove("is-dragging"); this.addAssets(Array.from(event.dataTransfer.files || []), draw); } } }, h("div", {}, h("strong", { text: "ここに図・表・データをドロップ" }), h("p", { text: "またはクリックして選択．PNG，JPEG，SVG，PDF，CSV，JSON，TXT，YAMLに対応します．" }), button("ファイルを選ぶ", "button-secondary", (event) => { event.stopPropagation(); input.click(); })));
      const list = h("div", { className: "asset-list" });
      const draw = () => {
        list.replaceChildren();
        this.wizardDraft.assets.forEach((asset, index) => list.appendChild(h("div", { className: "asset-row" }, h("div", { style: { flex: "1", minWidth: "0" } }, h("strong", { text: asset.displayName || asset.name }), h("div", { className: "card__meta" }, h("span", { text: `${Math.max(1, Math.round(asset.size / 1024))} KB` }), h("span", { text: asset.type || "形式不明" })), this.assetMetadataFields(asset, this.wizardDraft, () => this.queueWizardSave())), button("削除", "button-quiet", () => { this.wizardDraft.assets.splice(index, 1); this.queueWizardSave(); draw(); }))));
      };
      draw();
      container.append(input, zone, list);
      return container;
    }

    assetMetadataFields(asset, project, onChange) {
      const changed = () => {
        if (onChange) onChange();
      };
      const displayName = h("input", { className: "text-input", value: asset.displayName || asset.name || "", on: { input: (event) => { asset.displayName = PT.plainText(event.target.value, 300); changed(); } } });
      const caption = h("input", { className: "text-input", value: asset.caption || "", placeholder: "キャプションまたは説明", on: { input: (event) => { asset.caption = PT.plainText(event.target.value, 2000); changed(); } } });
      const targetSections = project.manuscript.sections.filter((section) => !["references", "bibliography"].includes(section.id));
      const target = h("select", { className: "select-input", on: { change: (event) => { asset.target = event.target.value; changed(); } } }, h("option", { value: "", text: "使用箇所を選択", selected: !asset.target }), targetSections.map((section) => h("option", { value: section.id, text: section.title, selected: asset.target === section.id })));
      const role = h("select", { className: "select-input", on: { change: (event) => { asset.role = event.target.value; changed(); } } }, [["figure", "図"], ["table", "表"], ["data", "データ"], ["other", "その他"]].map(([value, label]) => h("option", { value, text: label, selected: asset.role === value })));
      const origin = h("select", { className: "select-input", on: { change: (event) => { asset.origin = event.target.value; changed(); } } }, h("option", { value: "self", text: "自作", selected: asset.origin === "self" }), h("option", { value: "cited", text: "引用・転載", selected: asset.origin === "cited" }), h("option", { value: "unknown", text: "要確認", selected: asset.origin === "unknown" }));
      const source = h("input", { className: "text-input", value: asset.source || "", placeholder: "出典・作成元（引用時は必須）", on: { input: (event) => { asset.source = PT.plainText(event.target.value, 2000); changed(); } } });
      return h("div", { className: "form-grid", style: { marginTop: "10px" } }, field("表示名", displayName), field("用途", role), field("使用予定セクション", target), field("作成区分", origin), field("説明", caption), field("出典", source));
    }

    addAssets(files, redraw, targetProject) {
      const project = targetProject || this.wizardDraft;
      let added = 0;
      files.forEach((file) => {
        const result = PT.validateUpload(file, this.settings);
        if (!result.ok) {
          this.toast(`${file.name || "ファイル"}：${result.message}`, true);
          return;
        }
        const activeTarget = project.manuscript.sections.find((section) => section.id === project.ui.activeSectionId && !["abstract", "summary", "references", "bibliography"].includes(section.id));
        const preferredTarget = (activeTarget || project.manuscript.sections.find((section) => ["results", "experiments", "method"].includes(section.id)) || project.manuscript.sections.find((section) => !["abstract", "summary", "references", "bibliography"].includes(section.id)) || {}).id || "";
        project.assets.push({ id: PT.makeId("asset"), name: PT.safeFilename(file.name, "asset"), displayName: PT.plainText(file.name, 300), type: file.type || "application/octet-stream", size: file.size, lastModified: file.lastModified, caption: "", role: ["png", "jpg", "jpeg", "svg"].includes(result.extension) ? "figure" : result.extension === "pdf" ? "other" : "data", target: preferredTarget, source: "", origin: "self", data: file });
        added += 1;
      });
      if (added) this.toast(`${added}件のファイルを追加しました．`);
      if (added && targetProject) this.queueProjectSave(project);
      if (added && !targetProject) this.queueWizardSave();
      redraw();
    }

    instructionPresetNames() {
      return ["簡潔に", "学術的に", "受動態を減らす", "数値を優先", "限界を明示", "再現性を重視", "関連研究と比較", "図表を提案", "専門用語を定義", "英語表記を統一", "査読者の観点で確認"];
    }

    wizardInstructions() {
      const draft = this.wizardDraft;
      const container = h("div");
      const grid = h("div", { className: "form-grid" });
      grid.appendChild(this.inputFor("論文全体への指示", "global-instruction", draft.instructions.global, (event) => { draft.instructions.global = PT.plainText(event.target.value, 20000); }, { multiline: true, full: true, placeholder: "例：簡潔な学術文体とし，断定できない内容は明示する" }));
      const presets = this.instructionPresetNames();
      const checks = h("div", { className: "check-grid form-field--full" });
      presets.forEach((name) => {
        const checked = draft.instructions.presets.includes(name);
        const input = h("input", { type: "checkbox", checked, on: { change: (event) => { if (event.target.checked && !draft.instructions.presets.includes(name)) draft.instructions.presets.push(name); if (!event.target.checked) draft.instructions.presets = draft.instructions.presets.filter((item) => item !== name); } } });
        checks.appendChild(h("label", { className: "check-option" }, input, h("span", { text: name })));
      });
      grid.appendChild(field("指示プリセット", checks, "複数選択できます．"));
      container.appendChild(grid);
      const sectionInstructions = h("div", { className: "form-grid" });
      draft.manuscript.sections.forEach((section) => {
        sectionInstructions.appendChild(this.inputFor(section.title, `wizard-instruction-${section.id}`, draft.instructions.sections[section.id] || "", (event) => { draft.instructions.sections[section.id] = PT.plainText(event.target.value, 10000); }, { multiline: true, full: true, placeholder: "このセクションだけに適用する指示" }));
      });
      container.appendChild(h("details", { className: "details-panel", style: { marginTop: "16px" } }, h("summary", { text: "セクションごとの指示" }), h("p", { className: "field-help", text: "必要なセクションだけ入力してください．" }), sectionInstructions));
      container.appendChild(h("div", { className: "notice", style: { marginTop: "22px" } }, h("strong", { text: "生成方針" }), h("p", { text: "外部AIは使用しません．入力にない事実・数値・参考文献は作らず，不足箇所をTODOとして残します．" })));
      return container;
    }

    async changeWizardStep(direction) {
      if (direction > 0 && this.wizardStep === 1) {
        if (!this.wizardDraft.name.trim() || !this.wizardDraft.title.trim()) {
          this.toast("プロジェクト名と論文タイトルを入力してください．", true);
          return;
        }
      }
      const previousStep = this.wizardStep;
      const nextStep = Math.min(5, Math.max(1, previousStep + direction));
      this.wizardStep = nextStep;
      this.wizardDraft.ui.wizardStep = nextStep;
      const revision = ++this.wizardRevision;
      this.wizardDirty = true;
      if (!(await this.saveWizardDraft(revision))) {
        this.wizardStep = previousStep;
        this.wizardDraft.ui.wizardStep = previousStep;
        return;
      }
      if (root.history && typeof root.history.replaceState === "function") {
        root.history.replaceState(null, "", `#new/${encodeURIComponent(this.wizardDraft.id)}/${this.wizardStep}`);
      }
      await this.renderRoute();
    }

    queueWizardSave() {
      if (!this.wizardDraft || this.wizardFinishing || this.deletedProjectIds.has(this.wizardDraft.id)) return;
      this.wizardDirty = true;
      const revision = ++this.wizardRevision;
      this.repo.saveEmergencyProject(this.wizardDraft);
      if (this.wizardSaveTimer) root.clearTimeout(this.wizardSaveTimer);
      this.wizardSaveTimer = root.setTimeout(() => {
        this.wizardSaveTimer = null;
        this.saveWizardDraft(revision);
      }, 650);
    }

    async saveWizardDraft(revision) {
      if (!this.wizardDraft) return true;
      if (this.wizardSavePromise) await this.wizardSavePromise;
      const draft = this.wizardDraft;
      if (!draft) return true;
      if (this.deletedProjectIds.has(draft.id)) return true;
      const targetRevision = revision == null ? this.wizardRevision : revision;
      this.wizardSavePromise = (async () => {
        try {
          const saved = await this.repo.saveProject(draft, { clearRecovery: false });
          draft.updatedAt = saved.updatedAt;
          if (this.wizardDraft === draft && this.wizardRevision === targetRevision) {
            this.wizardDirty = false;
            this.repo.clearEmergencyProject(draft.id);
            this.saveState.textContent = "下書き保存済み";
          }
          return true;
        } catch (error) {
          this.toast(`途中保存に失敗しました：${error.message}`, true);
          return false;
        } finally {
          this.wizardSavePromise = null;
        }
      })();
      return this.wizardSavePromise;
    }

    async flushWizardSave() {
      if (this.wizardSaveTimer) {
        root.clearTimeout(this.wizardSaveTimer);
        this.wizardSaveTimer = null;
      }
      if (this.wizardSavePromise) await this.wizardSavePromise;
      if (!this.wizardDraft || !this.wizardDirty) return true;
      return this.saveWizardDraft(this.wizardRevision);
    }

    async finishWizard() {
      if (!this.wizardDraft.title.trim()) {
        this.wizardStep = 1;
        this.wizardDraft.ui.wizardStep = 1;
        this.toast("論文タイトルを入力してください．", true);
        await this.renderRoute();
        return;
      }
      if (this.wizardFinishing) return;
      this.wizardFinishing = true;
      this.saveState.textContent = "草稿を生成中";
      try {
        if (!(await this.flushWizardSave())) return;
        const project = PT.normalizeProject(this.wizardDraft);
        project.punctuation = this.settings.punctuation;
        project.history = PT.snapshotProject(project, "before-initial-generation", "project", this.settings);
        const generated = PT.generateManuscript(project);
        project.manuscript = Object.assign({}, project.manuscript, generated);
        project.manuscript.advice = PT.analyzeProject(project, project.manuscript);
        project.manuscript.generatedAt = PT.nowIso();
        project.status = "generated";
        project.typstSource = "";
        project.history = PT.snapshotProject(project, "after-initial-generation", "project", this.settings);
        this.currentProject = await this.repo.saveProject(project);
        this.wizardDraft = null;
        this.wizardDirty = false;
        await this.refreshProjects();
        this.toast("最初の草稿を作成しました．");
        this.navigate(`editor/${encodeURIComponent(this.currentProject.id)}`);
      } catch (error) {
        this.saveState.textContent = "生成失敗";
        this.toast(`草稿を作成できませんでした：${error.message}`, true);
      } finally {
        this.wizardFinishing = false;
      }
    }

    async openEditor(id) {
      if (!id) return this.navigate("projects");
      if (!this.currentProject || this.currentProject.id !== id) this.currentProject = await this.repo.getProject(id);
      if (!this.currentProject) {
        this.main.replaceChildren(emptyState("プロジェクトが見つかりません", "削除されたか，別のブラウザ保存領域にあります．", "一覧へ戻る", () => this.navigate("projects")));
        return;
      }
      if (!this.currentProject.manuscript.generatedAt && !this.currentProject.manuscript.sections.some((section) => section.content.trim())) {
        const generated = PT.generateManuscript(this.currentProject);
        this.currentProject.manuscript = Object.assign({}, this.currentProject.manuscript, generated);
        this.currentProject.manuscript.advice = PT.analyzeProject(this.currentProject, this.currentProject.manuscript);
        this.currentProject.manuscript.generatedAt = PT.nowIso();
        await this.repo.saveProject(this.currentProject);
      }
      this.renderEditor();
    }

    renderEditor() {
      const project = this.currentProject;
      project.punctuation = this.settings.punctuation;
      let activeId = project.ui.activeSectionId;
      if (!project.manuscript.sections.some((section) => section.id === activeId)) activeId = project.manuscript.sections[0] && project.manuscript.sections[0].id;
      project.ui.activeSectionId = activeId;
      const active = project.manuscript.sections.find((section) => section.id === activeId) || project.manuscript.sections[0];
      const completeness = PT.projectCompleteness(project);
      const page = h("div", { className: "page page--wide" });
      const editor = h("div", { className: "editor-shell" });
      editor.append(this.editorSidebar(project, activeId, completeness), this.editorMain(project, active), this.editorInspector(project));
      page.appendChild(editor);
      this.main.replaceChildren(page);
      this.contextActions.replaceChildren(
        button("保存", "button-secondary", () => this.saveCurrentProject(true)),
        button("AI作業台", "button-secondary", () => this.navigate(`assistant/${encodeURIComponent(project.id)}`)),
        button("Typst一式", "button-secondary", () => this.downloadTypst(project)),
        button("ZIPバックアップ", "button-secondary", () => this.downloadArchive(project)),
        button("印刷・PDF", "button", () => this.printProject(project)),
      );
    }

    editorSidebar(project, activeId, completeness) {
      const sectionNav = h("div", { className: "section-nav", role: "navigation", ariaLabel: "論文セクション" });
      project.manuscript.sections.forEach((section) => {
        const words = section.content.trim().length;
        sectionNav.appendChild(h("button", { type: "button", ariaCurrent: section.id === activeId ? "true" : "false", on: { click: () => { project.ui.activeSectionId = section.id; this.editorMode = "content"; this.renderEditor(); } } }, h("span", { text: section.title }), h("span", { className: words ? "badge badge--accent" : "badge", text: words ? "済" : "空" })));
      });
      return h(
        "aside",
        { className: "editor-sidebar" },
        h("div", { className: "editor-project-name" }, h("strong", { text: project.name }), h("small", { text: project.title || "タイトル未入力" }), h("div", { className: "completion-meter", ariaLabel: `入力充足度 ${completeness}%` }, h("span", { style: { width: `${completeness}%` } }))),
        sectionNav,
        h("div", { className: "card__actions", style: { marginTop: "16px" } }, button("全体を再生成", "button-secondary", () => this.generateAll()), button("診断を更新", "button-quiet", () => this.refreshAdvice())),
      );
    }

    editorMain(project, active) {
      const body = h("section", { className: "editor-main" });
      const toggle = h("div", { className: "segmented-control", ariaLabel: "編集表示" }, button("本文", "", () => { this.editorMode = "content"; this.renderEditor(); }, { ariaPressed: this.editorMode === "content" ? "true" : "false" }), button("Typst", "", () => { this.editorMode = "source"; this.renderEditor(); }, { ariaPressed: this.editorMode === "source" ? "true" : "false" }));
      const toolbar = h("div", { className: "editor-toolbar" }, toggle, h("div", { className: "button-row" }, this.editorMode === "content" ? button("このセクションを再生成", "button-secondary", () => this.regenerateActiveSection()) : button("生成ソースへ戻す", "button-secondary", () => this.resetTypstSource()), button("履歴を見る", "button-quiet", () => { this.inspectorTab = "history"; this.renderEditor(); })));
      const documentPanel = h("div", { className: "editor-document" });
      if (this.editorMode === "source") {
        documentPanel.appendChild(h("h1", { text: "Typstソース" }));
        const source = project.typstSource || PT.renderTypst(project);
        const sourceArea = h("textarea", { className: "source-textarea", value: source, maxLength: 2000000, spellcheck: false, ariaLabel: "Typstソース", on: { focus: () => this.snapshotTypstOnce(), input: (event) => { project.typstSource = PT.plainText(event.target.value, 2000000); this.setSaveState("未保存"); this.queueProjectSave(project); } } });
        documentPanel.append(sourceArea, h("p", { className: "field-help", text: "直接編集した内容はTypst書き出しへ保存されます（最大200万文字）．ブラウザー印刷には反映されません．草稿を再生成すると自動生成ソースへ戻ります．" }));
      } else {
        documentPanel.appendChild(h("h1", { text: active.title }));
        if (project.typstSource) documentPanel.appendChild(h("div", { className: "notice notice--warning", text: "直接編集したTypstソースがあります．本文の変更はそのソースへ自動反映されません．Typstタブで「生成ソースへ戻す」と同期できます．" }));
        const editorArea = h("textarea", { className: "manuscript-textarea", value: active.content, ariaLabel: `${active.title} 本文`, on: { input: (event) => { active.content = PT.plainText(event.target.value, 100000); active.updatedAt = PT.nowIso(); this.setSaveState("未保存"); this.queueProjectSave(project); } } });
        const instruction = textarea(`instruction-${active.id}`, project.instructions.sections[active.id] || "", "このセクションだけに適用する指示", (event) => { project.instructions.sections[active.id] = PT.plainText(event.target.value, 10000); this.setSaveState("未保存"); this.queueProjectSave(project); });
        documentPanel.append(editorArea, h("div", { className: "section-instruction" }, field("このセクションへの指示", instruction)));
      }
      body.append(toolbar, documentPanel);
      return body;
    }

    editorInspector(project) {
      const tabs = h("div", { className: "inspector-tabs", role: "tablist" });
      [["advice", "助言"], ["inputs", "研究情報"], ["assets", "図・データ"], ["history", "履歴"]].forEach(([id, label]) => tabs.appendChild(h("button", { type: "button", role: "tab", ariaSelected: this.inspectorTab === id ? "true" : "false", on: { click: () => { this.inspectorTab = id; this.renderEditor(); } }, text: label })));
      const content = h("div", { className: "inspector-content" });
      if (this.inspectorTab === "advice") content.appendChild(this.advicePanel(project));
      if (this.inspectorTab === "inputs") content.appendChild(this.inputsPanel(project));
      if (this.inspectorTab === "assets") content.appendChild(this.assetsPanel(project));
      if (this.inspectorTab === "history") content.appendChild(this.historyPanel(project));
      return h("aside", { className: "editor-inspector" }, tabs, content);
    }

    advicePanel(project) {
      const wrapper = h("div");
      const advice = (project.manuscript.advice || []).slice().sort((a, b) => Number(a.resolved) - Number(b.resolved));
      const unresolved = advice.filter((item) => !item.resolved).length;
      wrapper.appendChild(h("div", { className: "section-heading", style: { marginTop: "0" } }, h("div", {}, h("h2", { text: "不足情報" }), h("p", { text: `未解決 ${unresolved}件` }))));
      if (!advice.length) {
        wrapper.appendChild(h("div", { className: "notice", text: "一般的な不足情報はありません．" }));
      } else {
        const list = h("div", { className: "advice-list" });
        advice.forEach((item) => {
          const label = item.severity === "required" ? "必須" : item.severity === "recommended" ? "推奨" : "任意";
          list.appendChild(h("article", { className: `advice-card${item.resolved ? " is-resolved" : ""}`, dataset: { severity: item.severity } }, h("div", { className: "card__meta" }, h("span", { className: item.severity === "required" ? "badge badge--danger" : "badge badge--warning", text: label }), item.resolved ? h("span", { text: "解決済み" }) : null), h("h3", { text: item.title }), h("p", { text: item.reason }), h("p", { text: `追加内容：${item.action}` }), h("div", { className: "card__actions" }, button(item.resolved ? "未解決へ戻す" : "解決済みにする", "button-link", () => { item.resolved = !item.resolved; this.saveCurrentProject(false); this.renderEditor(); }), button("入力を確認", "button-link", () => { this.inspectorTab = "inputs"; this.renderEditor(); }))));
        });
        wrapper.appendChild(list);
      }

      if (typeof PT.auditEvidence === "function") {
        const audit = PT.auditEvidence(project);
        const actionable = audit.findings.filter((item) => item.status !== "ok");
        wrapper.appendChild(h("div", { className: "section-heading evidence-heading" }, h("div", {}, h("h2", { text: "不足する図・データ" }), h("p", { text: `不足 ${audit.summary.missing}件・提案 ${audit.summary.recommended}件・確認済み ${audit.summary.ok}件` }))));
        if (!actionable.length) {
          wrapper.appendChild(h("div", { className: "notice", text: "現在の入力範囲では，追加すべき図・データは検出されませんでした．" }));
        } else {
          const evidenceList = h("div", { className: "advice-list evidence-list" });
          actionable.forEach((item) => {
            const isMissing = item.status === "missing";
            evidenceList.appendChild(h("article", { className: "advice-card evidence-card", dataset: { severity: isMissing ? "required" : "recommended" } },
              h("div", { className: "card__meta" }, h("span", { className: isMissing ? "badge badge--danger" : "badge badge--warning", text: isMissing ? "不足" : "提案" }), h("span", { text: item.targetSectionTitle || item.targetSection || "プロジェクト全体" })),
              h("h3", { text: item.title }),
              h("p", { text: item.reason }),
              h("p", { text: `追加内容：${item.action}` }),
              h("p", { className: "field-help", text: `推奨形式：${item.recommendedFormat}` }),
              h("div", { className: "card__actions" },
                button("研究情報を確認", "button-link", () => { if (project.manuscript.sections.some((section) => section.id === item.targetSection)) project.ui.activeSectionId = item.targetSection; this.inspectorTab = "inputs"; this.renderEditor(); }),
                button("図・データを確認", "button-link", () => { if (project.manuscript.sections.some((section) => section.id === item.targetSection)) project.ui.activeSectionId = item.targetSection; this.inspectorTab = "assets"; this.renderEditor(); }),
              ),
            ));
          });
          wrapper.appendChild(evidenceList);
        }
      }
      return wrapper;
    }

    editorAuthors(project) {
      const container = h("div", { className: "repeater-list" });
      const draw = () => {
        container.replaceChildren();
        project.authors.forEach((author, index) => {
          const update = () => { this.setSaveState("未保存"); this.queueProjectSave(project); };
          container.appendChild(h("div", { className: "repeater-row" },
            this.inputFor("氏名", `editor-author-name-${index}`, author.name, (event) => { author.name = PT.plainText(event.target.value, 200); update(); }),
            this.inputFor("所属", `editor-author-affiliation-${index}`, author.affiliation, (event) => { author.affiliation = PT.plainText(event.target.value, 300); update(); }),
            this.inputFor("メール", `editor-author-email-${index}`, author.email, (event) => { author.email = PT.plainText(event.target.value, 320); update(); }, { type: "email" }),
            this.inputFor("ORCID", `editor-author-orcid-${index}`, author.orcid, (event) => { author.orcid = PT.plainText(event.target.value, 40); update(); }),
            h("label", { className: "check-option" }, h("input", { type: "checkbox", checked: Boolean(author.corresponding), on: { change: (event) => { author.corresponding = event.target.checked; update(); } } }), h("span", { text: "連絡著者" })),
            h("div", { className: "button-row" },
              button("↑", "button-quiet", () => { if (index > 0) { const moved = project.authors.splice(index, 1)[0]; project.authors.splice(index - 1, 0, moved); update(); draw(); } }, { disabled: index === 0, ariaLabel: `${author.name || index + 1} を上へ` }),
              button("↓", "button-quiet", () => { if (index < project.authors.length - 1) { const moved = project.authors.splice(index, 1)[0]; project.authors.splice(index + 1, 0, moved); update(); draw(); } }, { disabled: index === project.authors.length - 1, ariaLabel: `${author.name || index + 1} を下へ` }),
              button("削除", "button-quiet", () => { project.authors.splice(index, 1); update(); draw(); }),
            ),
          ));
        });
        container.appendChild(button("著者を追加", "button-secondary", () => { project.authors.push({ id: PT.makeId("author"), name: "", affiliation: "", email: "", orcid: "", corresponding: false }); this.queueProjectSave(project); draw(); }));
      };
      draw();
      return container;
    }

    inputsPanel(project) {
      const wrapper = h("div");
      wrapper.appendChild(h("div", { className: "section-heading", style: { marginTop: "0" } }, h("div", {}, h("h2", { text: "研究情報" }), h("p", { text: "編集すると自動保存されます．" }))));
      const updateMetadata = (key, value, limit) => {
        project[key] = PT.plainText(value, limit);
        this.setSaveState("未保存");
        this.queueProjectSave(project);
      };
      const editorTemplate = PT.normalizeTemplateDefinition(project.templateDefinition) || PT.templateMap[project.templateId] || PT.TEMPLATES[0];
      const editorDocumentTypes = editorTemplate.documentTypes || [editorTemplate.type];
      const documentTypeSelect = h("select", { className: "select-input", on: { change: (event) => updateMetadata("documentType", event.target.value, 80) } }, editorDocumentTypes.map((value) => h("option", { value, text: this.documentTypeLabel(value), selected: project.documentType === value })));
      const englishVariantSelect = h("select", { className: "select-input", on: { change: (event) => { project.englishVariant = event.target.value === "british" ? "british" : "american"; this.setSaveState("未保存"); this.queueProjectSave(project); } } }, h("option", { value: "american", text: "American English", selected: project.englishVariant !== "british" }), h("option", { value: "british", text: "British English", selected: project.englishVariant === "british" }));
      const metadata = h("div", { className: "form-grid" },
        this.inputFor("プロジェクト名", "editor-project-name", project.name, (event) => updateMetadata("name", event.target.value, 200)),
        this.inputFor("論文タイトル", "editor-paper-title", project.title, (event) => updateMetadata("title", event.target.value, 500)),
        this.inputFor("研究分野", "editor-paper-field", project.field, (event) => updateMetadata("field", event.target.value, 300)),
        field("論文種別", documentTypeSelect),
        field("英語表記", englishVariantSelect),
        this.inputFor("ページ数の目安", "editor-paper-pages", project.pageTarget, (event) => updateMetadata("pageTarget", event.target.value, 40)),
        this.inputFor("キーワード", "editor-paper-keywords", project.keywords.join("，"), (event) => {
          project.keywords = event.target.value
            .split(/[,，\n]/)
            .map((item) => PT.plainText(item, 100).trim())
            .filter(Boolean)
            .slice(0, 30);
          this.setSaveState("未保存");
          this.queueProjectSave(project);
        }, { full: true, help: "カンマまたは改行で区切ります（最大30件）．" }),
        this.inputFor("対象読者", "editor-paper-audience", project.targetAudience, (event) => updateMetadata("targetAudience", event.target.value, 1000), { full: true }),
        this.inputFor("投稿先メモ", "editor-paper-submission", project.submissionNotes, (event) => updateMetadata("submissionNotes", event.target.value, 5000), { multiline: true, full: true }),
      );
      const simpleInputs = h("div", { className: "form-grid" });
      [["研究内容を自由に記述", "simpleDescription"], ["箇条書きメモ", "bulletNotes"], ["研究で実現したこと", "achievements"], ["最も伝えたい点", "keyMessage"]].forEach(([label, key]) => {
        simpleInputs.appendChild(this.inputFor(label, `editor-simple-${key}`, project.research[key], (event) => { project.research[key] = PT.plainText(event.target.value, 50000); this.setSaveState("未保存"); this.queueProjectSave(project); }, { multiline: true, full: true }));
      });
      const instructionChanged = () => { this.setSaveState("未保存"); this.queueProjectSave(project); };
      const instructionPresets = h("div", { className: "check-grid" });
      this.instructionPresetNames().forEach((name) => {
        instructionPresets.appendChild(h("label", { className: "check-option" }, h("input", { type: "checkbox", checked: project.instructions.presets.includes(name), on: { change: (event) => { if (event.target.checked && !project.instructions.presets.includes(name)) project.instructions.presets.push(name); if (!event.target.checked) project.instructions.presets = project.instructions.presets.filter((item) => item !== name); instructionChanged(); } } }), h("span", { text: name })));
      });
      const globalInstructions = h("div", { className: "form-grid" },
        this.inputFor("論文全体への指示", "editor-global-instruction", project.instructions.global, (event) => { project.instructions.global = PT.plainText(event.target.value, 20000); instructionChanged(); }, { multiline: true, full: true }),
        field("指示プリセット", instructionPresets, "全体再生成時に反映します．"),
      );
      const mapping = [["研究目的", "objective"], ["方法", "method"], ["実験・評価", "experimentalConditions"], ["結果", "results"], ["考察", "discussion"], ["限界", "limitations"], ["結論", "conclusion"]];
      const stack = h("div", { className: "grid" });
      mapping.forEach(([label, key]) => stack.appendChild(field(label, textarea(`inspector-${key}`, project.research[key], "", (event) => { project.research[key] = PT.plainText(event.target.value, 50000); this.setSaveState("未保存"); this.queueProjectSave(project); }))));
      const detailedStack = h("div", { className: "grid", style: { marginTop: "14px" } });
      [
        ["研究課題", "problem"],
        ["背景", "background"],
        ["新規性", "novelty"],
        ["システム構成", "systemDesign"],
        ["評価指標", "metrics"],
        ["比較対象", "comparison"],
        ["試行回数", "trialCount"],
        ["統計情報", "statistics"],
        ["文献検索手順", "searchStrategy"],
        ["分類基準", "classification"],
        ["研究上のギャップ", "researchGaps"],
        ["研究計画", "researchPlan"],
        ["期待結果", "expectedResults"],
        ["スケジュール", "schedule"],
        ["使用機器", "equipment"],
        ["再現性", "reproducibility"],
        ["今後の課題", "futureWork"],
      ].forEach(([label, key]) => {
        detailedStack.appendChild(
          field(label, textarea(`inspector-${key}`, project.research[key], "", (event) => {
            project.research[key] = PT.plainText(event.target.value, 50000);
            this.setSaveState("未保存");
            this.queueProjectSave(project);
          })),
        );
      });
      const detailedInputs = h(
        "details",
        { className: "details-panel" },
        h("summary", { text: "詳細な研究情報" }),
        detailedStack,
      );
      const references = h("div", { className: "reference-list" });
      const drawReferences = () => {
        references.replaceChildren();
        project.references.forEach((reference, index) => {
          const update = () => { this.setSaveState("未保存"); this.queueProjectSave(project); };
          const keyInput = h("input", { className: "text-input", value: reference.key || "", on: { change: (event) => {
            const candidate = PT.normalizeCitationKey(event.target.value);
            if (!candidate || project.references.some((item) => item !== reference && item.key === candidate)) {
              event.target.value = reference.key || "";
              return this.toast("引用キーは空にできず，他の文献と重複できません．", true);
            }
            reference.key = candidate;
            event.target.value = candidate;
            update();
          } } });
          const typeInput = h("select", { className: "select-input", on: { change: (event) => { reference.type = event.target.value; update(); } } }, [["article", "論文"], ["inproceedings", "会議論文"], ["book", "書籍"], ["thesis", "学位論文"], ["web", "Web"], ["misc", "その他"]].map(([value, label]) => h("option", { value, text: label, selected: reference.type === value })));
          const textInput = (value, placeholder, handler, multiline) => h(multiline ? "textarea" : "input", { className: multiline ? "text-area" : "text-input", value: value || "", placeholder, on: { input: (event) => { handler(event.target.value); update(); } } });
          const authorsValue = Array.isArray(reference.authors) ? reference.authors.join("; ") : reference.authors;
          const yearInput = h("input", { className: "text-input", value: reference.year || "", placeholder: "YYYY / YYYY-MM / YYYY-MM-DD", on: { change: (event) => {
            const raw = PT.plainText(event.target.value, 10).trim();
            const normalized = PT.normalizeReferenceDate(raw);
            if (raw && !normalized) {
              event.target.value = reference.year || "";
              return this.toast("日付形式を確認してください．", true);
            }
            reference.year = normalized;
            update();
          } } });
          references.appendChild(h("details", { className: "details-panel reference-row" },
            h("summary", { text: `${reference.key || `ref-${index + 1}`} — ${reference.title || "タイトル未入力"}` }),
            h("div", { className: "form-grid", style: { marginTop: "12px" } },
              field("引用キー", keyInput), field("種別", typeInput),
              field("タイトル", textInput(reference.title, "文献タイトル", (value) => { reference.title = PT.plainText(value, 1000); })),
              field("著者", textInput(authorsValue, "複数は ; 区切り", (value) => { reference.authors = PT.plainText(value, 1000); })),
              field("日付", yearInput),
              field("掲載誌・会議・出版社", textInput(reference.venue, "掲載先", (value) => { reference.venue = PT.plainText(value, 1000); })),
              field("DOI", textInput(reference.doi, "10.xxxx/...", (value) => { reference.doi = PT.plainText(value, 300); })),
              field("URL", textInput(reference.url, "https://...", (value) => { reference.url = PT.plainText(value, 2000); })),
              field("注記", textInput(reference.note, "確認事項", (value) => { reference.note = PT.plainText(value, 3000); }, true)),
            ),
            button("この文献を削除", "button-quiet", () => { project.references.splice(index, 1); update(); drawReferences(); }),
          ));
        });
      };
      drawReferences();
      const refKey = h("input", { className: "text-input", placeholder: "citation-key" });
      const refTitle = h("input", { className: "text-input", placeholder: "文献タイトル" });
      const refAuthors = h("input", { className: "text-input", placeholder: "著者（複数は ; 区切り）" });
      const refYear = h("input", { className: "text-input", placeholder: "年（例：2026）", inputMode: "numeric" });
      const addReference = () => {
        const citationKey = PT.normalizeCitationKey(refKey.value);
        if (!citationKey || !refTitle.value.trim()) return this.toast("引用キーと文献タイトルを入力してください．", true);
        if (project.references.some((item) => item.key === citationKey)) return this.toast("同じ引用キーが既にあります．", true);
        const rawDate = PT.plainText(refYear.value, 10).trim();
        const referenceDate = PT.normalizeReferenceDate(rawDate);
        if (rawDate && !referenceDate) return this.toast("年は YYYY，YYYY-MM，YYYY-MM-DD のいずれかで入力してください．", true);
        project.references.push({ id: PT.makeId("ref"), key: citationKey, type: "article", title: PT.plainText(refTitle.value, 1000), authors: PT.plainText(refAuthors.value, 1000), year: referenceDate, venue: "", doi: "", url: "", note: "" });
        refKey.value = refTitle.value = refAuthors.value = refYear.value = "";
        this.saveCurrentProject(false);
        drawReferences();
      };
      const bibtexInput = h("input", { type: "file", accept: ".bib,application/x-bibtex,text/plain", hidden: true, on: { change: async (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file) return;
        if (file.size > PT.MAX_BIBTEX_BYTES) return this.toast("BibTeXファイルが2 MBを超えています．", true);
        try {
          const imported = PT.parseBibtex(await file.text());
          const existing = new Set(project.references.map((reference) => reference.key));
          imported.forEach((reference) => {
            if (!reference.key || existing.has(reference.key)) throw new Error(`引用キー「${reference.key || "空"}」が重複しています．`);
            existing.add(reference.key);
          });
          imported.forEach((reference) => project.references.push(Object.assign({ id: PT.makeId("ref") }, reference)));
          this.queueProjectSave(project);
          drawReferences();
          this.toast(`${imported.length}件のBibTeX文献を読み込みました．`);
        } catch (error) {
          this.toast(`BibTeXを読み込めませんでした：${error.message}`, true);
        }
      } } });
      wrapper.append(
        h("details", { className: "details-panel", open: true }, h("summary", { text: "基本情報・著者" }), metadata, h("h3", { text: "著者", style: { marginTop: "18px" } }), this.editorAuthors(project)),
        h("details", { className: "details-panel" }, h("summary", { text: "簡易入力メモ" }), h("p", { className: "field-help", text: "作成時の簡易入力はここで更新できます．" }), simpleInputs),
        h("details", { className: "details-panel" }, h("summary", { text: "論文全体への指示" }), globalInstructions),
        stack,
        detailedInputs,
        h("div", { className: "section-heading" }, h("div", {}, h("h2", { text: "参考文献" }), h("p", { text: "確認済みの文献だけを登録します．" }))),
        references,
        h("div", { className: "grid" }, refKey, refTitle, refAuthors, refYear, button("参考文献を追加", "button-secondary", addReference)),
        h(
          "div",
          { className: "button-row", style: { marginTop: "12px" } },
          bibtexInput,
          button("BibTeXを読み込む", "button-secondary", () => bibtexInput.click()),
          button("BibTeXを保存", "button-quiet", () => {
            PT.downloadBlob(new Blob([PT.renderBibtex(project)], { type: "text/plain;charset=utf-8" }), `${PT.safeFilename(project.name, "references")}.bib`);
          }),
          button("YAMLを保存", "button-quiet", () => {
            PT.downloadBlob(new Blob([PT.renderReferencesYaml(project)], { type: "text/yaml;charset=utf-8" }), `${PT.safeFilename(project.name, "references")}.yml`);
          }),
        ),
      );
      return wrapper;
    }

    assetsPanel(project) {
      const wrapper = h("div");
      wrapper.appendChild(
        h(
          "div",
          { className: "section-heading", style: { marginTop: "0" } },
          h(
            "div",
            {},
            h("h2", { text: "図・表・データ" }),
            h("p", { text: "追加したファイルはZIPバックアップへ含まれます．" }),
          ),
        ),
      );
      const fileInput = h("input", {
        type: "file",
        multiple: true,
        accept: ".png,.jpg,.jpeg,.svg,.pdf,.csv,.json,.txt,.yaml,.yml",
        hidden: true,
        on: {
          change: (event) => {
            this.addAssets(Array.from(event.target.files || []), draw, project);
            event.target.value = "";
          },
        },
      });
      const list = h("div", { className: "asset-list" });
      const draw = () => {
        list.replaceChildren();
        if (!project.assets.length) {
          list.appendChild(h("div", { className: "notice", text: "図・データはまだ追加されていません．" }));
          return;
        }
        project.assets.forEach((asset, index) => {
          list.appendChild(
            h(
              "div",
              { className: "asset-row" },
              h(
                "div",
                { style: { flex: "1", minWidth: "0" } },
                h("strong", { text: asset.displayName || asset.name }),
                h("div", { className: "field-help", text: `${Math.max(1, Math.round(asset.size / 1024))} KB` }),
                this.assetMetadataFields(asset, project, () => { this.setSaveState("未保存"); this.queueProjectSave(project); }),
              ),
              button("削除", "button-quiet", () => {
                project.assets.splice(index, 1);
                this.queueProjectSave(project);
                draw();
              }),
            ),
          );
        });
      };
      draw();
      wrapper.append(fileInput, button("ファイルを追加", "button-secondary", () => fileInput.click()), list);
      return wrapper;
    }

    historyPanel(project) {
      const wrapper = h("div");
      wrapper.appendChild(h("div", { className: "section-heading", style: { marginTop: "0" } }, h("div", {}, h("h2", { text: "変更履歴" }), h("p", { text: "生成前後と手動保存時の状態です．" }))));
      if (!project.history.length) return h("div", {}, wrapper, h("div", { className: "notice", text: "履歴はまだありません．" }));
      const list = h("div", { className: "history-list" });
      project.history
        .slice()
        .reverse()
        .forEach((snapshot) => {
          list.appendChild(
            h(
              "div",
              { className: "history-row" },
              h(
                "div",
                {},
                h("strong", { text: this.historyLabel(snapshot.action) }),
                h("div", {
                  className: "field-help",
                  text: PT.formatDate(snapshot.createdAt, project.language),
                }),
              ),
              button("復元", "button-link", () => this.restoreSnapshot(snapshot.id)),
            ),
          );
        });
      wrapper.appendChild(list);
      return wrapper;
    }

    historyLabel(action) {
      const labels = { "before-initial-generation": "初回生成の前", "after-initial-generation": "初回生成の後", "before-full-generation": "全体再生成の前", "after-full-generation": "全体再生成の後", "before-section-generation": "セクション再生成の前", "after-section-generation": "セクション再生成の後", "manual-save": "手動保存", "before-typst-edit": "Typst直接編集の前" };
      return labels[action] || action || "保存";
    }

    async saveCurrentProject(manual) {
      if (this.currentProject) this.cancelPendingSave(this.currentProject.id);
      if (!this.currentProject) return true;
      const revision = this.markProjectDirty(this.currentProject);
      return this.startProjectSave(this.currentProject, manual, revision);
    }

    markProjectDirty(project) {
      const revision = ++this.saveRevision;
      this.dirtyProjects.set(project.id, { project, revision });
      return revision;
    }

    startProjectSave(project, manual, revision) {
      const promise = this.saveProjectObject(project, manual, revision);
      this.inFlightSaves.add(promise);
      promise.finally(() => this.inFlightSaves.delete(promise));
      return promise;
    }

    queueProjectSave(project) {
      if (!project || this.deletedProjectIds.has(project.id)) return;
      this.cancelPendingSave(project.id);
      const revision = this.markProjectDirty(project);
      const timer = root.setTimeout(() => {
        this.pendingSaves.delete(project.id);
        this.startProjectSave(project, false, revision);
      }, 650);
      this.pendingSaves.set(project.id, { project, timer, revision });
    }

    cancelPendingSave(projectId) {
      const pending = this.pendingSaves.get(projectId);
      if (!pending) return;
      root.clearTimeout(pending.timer);
      this.pendingSaves.delete(projectId);
    }

    async flushPendingSaves() {
      const pending = Array.from(this.pendingSaves.values());
      this.pendingSaves.clear();
      pending.forEach((item) => root.clearTimeout(item.timer));
      pending.forEach((item) => this.startProjectSave(item.project, false, item.revision));
      if (this.inFlightSaves.size) await Promise.all(Array.from(this.inFlightSaves));
      return this.dirtyProjects.size === 0;
    }

    persistEmergencyDrafts() {
      this.dirtyProjects.forEach((item) => this.repo.saveEmergencyProject(item.project));
      if (this.wizardDraft && this.wizardDirty) this.repo.saveEmergencyProject(this.wizardDraft);
    }

    async saveProjectObject(project, manual, revision) {
      if (!project) return true;
      if (this.deletedProjectIds.has(project.id) || this.staleProjectObjects.has(project)) {
        const dirty = this.dirtyProjects.get(project.id);
        if (dirty && dirty.project === project && dirty.revision === revision) {
          this.dirtyProjects.delete(project.id);
        }
        return true;
      }
      const isCurrent = this.currentProject && this.currentProject.id === project.id;
      if (isCurrent) this.setSaveState("保存中…");
      try {
        if (manual) project.history = PT.snapshotProject(project, "manual-save", "project", this.settings);
        const saved = await this.repo.saveProject(project, { clearRecovery: false });
        // Keep the live object identity so textarea event handlers continue to update
        // the same object after an autosave has completed.
        project.updatedAt = saved.updatedAt;
        const dirty = this.dirtyProjects.get(project.id);
        if (!dirty || dirty.revision === revision) {
          this.dirtyProjects.delete(project.id);
          this.repo.clearEmergencyProject(project.id);
          if (isCurrent) this.setSaveState("保存済み");
        } else if (isCurrent) {
          this.setSaveState("未保存");
        }
        if (manual && isCurrent) this.toast("保存しました．");
        return true;
      } catch (error) {
        if (isCurrent) this.setSaveState("保存失敗");
        this.toast(`保存に失敗しました：${error.message}`, true);
        return false;
      }
    }

    setSaveState(text) {
      this.saveState.textContent = text;
    }

    async generateAll() {
      const ok = await this.confirm("全体を再生成", "現在のセクション本文をルールベースの草稿で置き換えます．履歴から復元できます．", "再生成する", false);
      if (!ok) return;
      const project = this.currentProject;
      project.punctuation = this.settings.punctuation;
      project.history = PT.snapshotProject(project, "before-full-generation", "project", this.settings);
      const generated = PT.generateManuscript(project);
      project.manuscript = Object.assign({}, project.manuscript, generated);
      project.manuscript.advice = PT.analyzeProject(project, project.manuscript);
      project.manuscript.generatedAt = PT.nowIso();
      project.typstSource = "";
      project.ui.typstSnapshotTaken = false;
      project.history = PT.snapshotProject(project, "after-full-generation", "project", this.settings);
      if (!(await this.saveCurrentProject(false))) return;
      this.toast("全体を再生成しました．");
      this.renderEditor();
    }

    async regenerateActiveSection() {
      const project = this.currentProject;
      const id = project.ui.activeSectionId;
      const section = project.manuscript.sections.find((item) => item.id === id);
      if (!section) return;
      project.history = PT.snapshotProject(project, "before-section-generation", id, this.settings);
      section.content = PT.regenerateSection(project, id, section.content);
      section.updatedAt = PT.nowIso();
      project.manuscript.advice = PT.analyzeProject(project, project.manuscript);
      project.typstSource = "";
      project.ui.typstSnapshotTaken = false;
      project.history = PT.snapshotProject(project, "after-section-generation", id, this.settings);
      if (!(await this.saveCurrentProject(false))) return;
      this.toast(`${section.title}を再生成しました．`);
      this.renderEditor();
    }

    async refreshAdvice() {
      this.currentProject.manuscript.advice = PT.analyzeProject(this.currentProject, this.currentProject.manuscript);
      if (!(await this.saveCurrentProject(false))) return;
      this.inspectorTab = "advice";
      this.toast("不足情報を再診断しました．");
      this.renderEditor();
    }

    snapshotTypstOnce() {
      if (this.currentProject.ui.typstSnapshotTaken) return;
      this.currentProject.history = PT.snapshotProject(this.currentProject, "before-typst-edit", "main.typ", this.settings);
      this.currentProject.ui.typstSnapshotTaken = true;
    }

    async resetTypstSource() {
      const ok = await this.confirm("Typstソースを戻す", "直接編集したTypstソースを破棄し，現在の本文から再生成します．", "再生成する", false);
      if (!ok) return;
      this.currentProject.typstSource = "";
      this.currentProject.ui.typstSnapshotTaken = false;
      if (!(await this.saveCurrentProject(false))) return;
      this.renderEditor();
    }

    async restoreSnapshot(id) {
      const snapshot = this.currentProject.history.find((item) => item.id === id);
      if (!snapshot || !snapshot.project) return this.toast("履歴データを読み取れません．", true);
      const ok = await this.confirm("履歴を復元", "現在の本文と研究情報を選択した時点へ戻します．添付ファイルは保持されます．", "復元する", false);
      if (!ok) return;
      if (!(await this.flushPendingSaves())) return;
      const previousProject = this.currentProject;
      const currentAssets = previousProject.assets;
      const currentHistory = previousProject.history;
      const restored = PT.normalizeProject(snapshot.project);
      restored.id = previousProject.id;
      restored.assets = currentAssets;
      restored.history = currentHistory;
      restored.history = PT.snapshotProject(restored, "restore", snapshot.target || "project", this.settings);
      try {
        const saved = await this.repo.saveProject(restored);
        this.staleProjectObjects.add(previousProject);
        this.currentProject = saved;
        this.toast("履歴を復元しました．");
        this.renderEditor();
      } catch (error) {
        this.toast(`履歴の復元に失敗しました：${error.message}`, true);
      }
    }

    async duplicateProject(id) {
      try {
        const project = await this.repo.duplicateProject(id);
        await this.refreshProjects();
        this.toast("プロジェクトを複製しました．");
        this.navigate(`editor/${encodeURIComponent(project.id)}`);
      } catch (error) {
        this.toast(error.message, true);
      }
    }

    async deleteProject(project) {
      const ok = await this.confirm("プロジェクトを削除", `「${project.name}」をこのブラウザから削除します．この操作は元に戻せません．`, "削除する", true);
      if (!ok) return;
      try {
        const savesCompleted = await this.flushPendingSaves();
        if (!savesCompleted) return;
        if (this.wizardDraft && this.wizardDraft.id === project.id && !(await this.flushWizardSave())) return;
        this.deletedProjectIds.add(project.id);
        await this.repo.deleteProject(project.id);
        this.staleProjectObjects.add(project);
        this.dirtyProjects.delete(project.id);
        if (this.currentProject && this.currentProject.id === project.id) this.currentProject = null;
        if (this.wizardDraft && this.wizardDraft.id === project.id) {
          if (this.wizardSaveTimer) root.clearTimeout(this.wizardSaveTimer);
          this.wizardSaveTimer = null;
          this.wizardDraft = null;
          this.wizardDirty = false;
        }
        await this.refreshProjects();
        this.toast("プロジェクトを削除しました．");
        await this.renderRoute();
      } catch (error) {
        this.deletedProjectIds.delete(project.id);
        this.toast(`削除に失敗しました：${error.message}`, true);
      }
    }

    downloadJson(project) {
      try {
        const payload = PT.serializeProject(project);
        PT.downloadBlob(new Blob([payload], { type: "application/json;charset=utf-8" }), `${PT.safeFilename(project.name, "paper-tools")}.json`);
        this.toast(
          project.assets.some((asset) => asset.data)
            ? "本文JSONを保存しました．添付ファイルを含む完全な復元にはZIPを利用してください．"
            : "本文JSONを保存しました．",
        );
      } catch (error) {
        this.toast(`本文JSONの保存に失敗しました：${error.message}`, true);
      }
    }

    async downloadTypst(project) {
      try {
        const unsupported = this.unsupportedEmbeddedAssets(project, "typst");
        if (unsupported.length) {
          return this.toast(`次の図表は画像形式ではないためTypst本文へ自動配置できません：${unsupported.map((asset) => asset.displayName || asset.name).join("，")}．PNG，JPEG，SVGへ変換するか，用途を「データ」へ変更してください．`, true);
        }
        const baseName = PT.safeFilename(project.name, "paper");
        if (project.references.length || project.assets.length) {
          const bundle = await PT.createTypstBundle(project);
          PT.downloadBlob(bundle, `${baseName}-typst.zip`);
          this.toast("Typstソース・参考文献・添付ファイルを保存しました．");
        } else {
          PT.downloadBlob(
            new Blob([PT.renderTypst(project)], { type: "text/plain;charset=utf-8" }),
            `${baseName}.typ`,
          );
          this.toast("Typstソースを保存しました．");
        }
      } catch (error) {
        this.toast(`Typst書き出しに失敗しました：${error.message}`, true);
      }
    }

    unsupportedEmbeddedAssets(project, output) {
      const supported = new Set(output === "typst" ? ["png", "jpg", "jpeg", "svg", "pdf"] : ["png", "jpg", "jpeg", "svg"]);
      return project.assets.filter((asset) => ["figure", "table"].includes(asset.role) && asset.target && !supported.has(PT.extensionOf(asset.name)));
    }

    async downloadArchive(project) {
      try {
        this.setSaveState("ZIP作成中…");
        const blob = await PT.createProjectArchive(project);
        PT.downloadBlob(blob, `${PT.safeFilename(project.name, "paper-tools")}.zip`);
        this.setSaveState("保存済み");
        this.toast("ZIPバックアップを保存しました．");
      } catch (error) {
        this.setSaveState("ZIP失敗");
        this.toast(`ZIP作成に失敗しました：${error.message}`, true);
      }
    }

    printProject(project) {
      if (project.typstSource) {
        return this.toast("直接編集したTypstソースはブラウザー印刷へ反映できません．Typst一式を書き出して外部でコンパイルするか，Typstタブで生成ソースへ戻してください．", true);
      }
      const missingFigures = project.assets.filter((asset) => ["figure", "table"].includes(asset.role) && asset.target && !asset.data);
      if (missingFigures.length) {
        return this.toast(`図表ファイル本体がありません：${missingFigures.map((asset) => asset.name).join("，")}．元ファイルを再追加してください．`, true);
      }
      const unsupported = this.unsupportedEmbeddedAssets(project, "print");
      if (unsupported.length) {
        return this.toast(`ブラウザー印刷へ直接配置できない図表形式です：${unsupported.map((asset) => asset.displayName || asset.name).join("，")}．PNG，JPEG，SVGへ変換するか，データ用途に変更してください．`, true);
      }
      const popup = root.open("", "paper_tools_print", "popup,width=960,height=800");
      if (!popup) return this.toast("印刷画面を開けませんでした．ポップアップを許可してください．", true);
      try {
        const assetSources = new Map();
        const objectUrls = [];
        project.assets.forEach((asset) => {
          if (!["figure", "table"].includes(asset.role) || !asset.data) return;
          if (typeof asset.data === "string" && asset.data.startsWith("data:")) {
            assetSources.set(asset.id, asset.data);
          } else if (root.URL && typeof root.URL.createObjectURL === "function" && asset.data instanceof root.Blob) {
            const url = root.URL.createObjectURL(asset.data);
            objectUrls.push(url);
            assetSources.set(asset.id, url);
          }
        });
        popup.document.open();
        popup.document.write(PT.projectToPrintHtml(project, assetSources));
        popup.document.close();
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          objectUrls.forEach((url) => root.URL.revokeObjectURL(url));
        };
        popup.addEventListener("afterprint", cleanup, { once: true });
        root.setTimeout(cleanup, 60000);
        const imageWaits = Array.from(popup.document.images).map((image) => new Promise((resolve) => {
          if (image.complete) resolve();
          else {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }
        }));
        Promise.race([
          Promise.all(imageWaits),
          new Promise((resolve) => root.setTimeout(resolve, 3000)),
        ]).then(() => {
          popup.focus();
          popup.print();
        });
      } catch (error) {
        popup.close();
        this.toast(`印刷画面を作成できませんでした：${error.message}`, true);
      }
    }

    async importProject(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
      const sizeLimit = PT.MAX_BACKUP_BYTES;
      if (file.size > sizeLimit) {
        return this.toast("バックアップが100 MBを超えています．", true);
      }
      try {
        let parsed;
        let archiveEntries = null;
        let manifest = null;
        if (isZip) {
          archiveEntries = await PT.extractZip(file, { maxBytes: PT.MAX_BACKUP_BYTES, maxEntries: PT.MAX_BACKUP_ENTRIES });
          if (!archiveEntries["project.json"]) throw new Error("project.json がZIP内にありません．");
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(archiveEntries["project.json"]));
          if (archiveEntries["manifest.json"]) {
            manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(archiveEntries["manifest.json"]));
          }
          if (!manifest || manifest.format !== "paper-tools-project-archive" || manifest.version !== 1) {
            throw new Error("対応するpaper_tools ZIPバックアップではありません．");
          }
        } else {
          parsed = JSON.parse(await file.text());
        }
        const payload = parsed.project || parsed;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("プロジェクト形式ではありません．");
        }
        if (
          payload.schemaVersion != null &&
          (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1)
        ) {
          throw new Error("schemaVersionが不正です．");
        }
        if (payload.schemaVersion > PT.SCHEMA_VERSION) {
          throw new Error("このバックアップは新しいpaper_toolsで作成されています．アプリを更新してください．");
        }
        const project = PT.normalizeProject(payload);
        const citationKeys = project.references.map((reference) => reference.key).filter(Boolean);
        if (new Set(citationKeys).size !== citationKeys.length) {
          throw new Error("参考文献の引用キーが重複しています．読込み元を修正してください．");
        }
        if (archiveEntries) this.restoreArchiveAssets(project, manifest, archiveEntries);
        const exists = await this.repo.getProject(project.id);
        if (exists || this.deletedProjectIds.has(project.id)) {
          project.id = PT.makeId("project");
          project.name = `${project.name}（読み込み）`;
        }
        this.deletedProjectIds.delete(project.id);
        if (!archiveEntries) {
          project.assets = project.assets.map((asset) => Object.assign({}, asset, { data: null }));
        }
        project.createdAt = PT.nowIso();
        project.updatedAt = project.createdAt;
        this.currentProject = await this.repo.saveProject(project);
        await this.refreshProjects();
        this.toast(isZip ? "ZIPバックアップと添付ファイルを読み込みました．" : "JSONバックアップを読み込みました．");
        this.navigate(`editor/${encodeURIComponent(project.id)}`);
      } catch (error) {
        this.toast(`バックアップを読み込めませんでした：${error.message}`, true);
      }
    }

    restoreArchiveAssets(project, manifest, entries) {
      const manifestAssets = manifest && Array.isArray(manifest.assets) ? manifest.assets : [];
      const metadataById = new Map(project.assets.map((asset) => [asset.id, asset]));
      if (metadataById.size !== project.assets.length || manifestAssets.length !== project.assets.length) {
        throw new Error("添付ファイル一覧の整合性を確認できません．");
      }
      const restoredIds = new Set();
      const restoredPaths = new Set();
      manifestAssets.forEach((item, index) => {
        const path = PT.plainText(item && item.path, 500);
        const id = PT.plainText(item && item.id, 120);
        if (!path || !id || restoredIds.has(id) || restoredPaths.has(path)) {
          throw new Error("添付ファイルのマニフェストが不正です．");
        }
        if (!Object.prototype.hasOwnProperty.call(entries, path)) {
          throw new Error(`${item.name || path} がZIP内にありません．`);
        }
        const bytes = entries[path];
        if (Number.isFinite(item.size) && Number(item.size) !== bytes.byteLength) {
          throw new Error(`${item.name || path} のサイズがマニフェストと一致しません．`);
        }
        const existing = metadataById.get(id);
        if (!existing) throw new Error(`${item.name || path} のメタデータがproject.jsonにありません．`);
        const asset = existing;
        asset.name = PT.safeFilename(item.name || asset.name, `asset-${index + 1}`);
        asset.type = PT.plainText(item.type || asset.type, 160) || "application/octet-stream";
        asset.size = bytes.byteLength;
        asset.data = new Blob([bytes], { type: asset.type });
        restoredIds.add(id);
        restoredPaths.add(path);
      });
    }

    async renderAssistant(identifier) {
      await this.refreshProjects();
      const project = this.projects.find((item) => item.id === identifier)
        || (this.currentProject && this.projects.find((item) => item.id === this.currentProject.id))
        || this.projects[0];
      const page = this.page("AIプロンプト作業台", "原稿を外部送信せず，ローカルLLMやCodex／Claude Codeへ渡す指示文だけを作成します．", true);
      if (!project) {
        page.appendChild(emptyState("対象プロジェクトがありません", "先に論文プロジェクトを作成すると，英文変換・模擬査読・内容補強のプロンプトを生成できます．", "新規作成", () => this.navigate("new")));
        return;
      }

      const projectSelect = h("select", { id: "assistant-project", className: "select-input" }, this.projects.map((item) => h("option", { value: item.id, text: item.name, selected: item.id === project.id })));
      const typeSelect = h("select", { id: "assistant-type", className: "select-input" },
        h("option", { value: "translate-english", text: "英文変換（日本語 → 英語）" }),
        h("option", { value: "peer-review", text: "模擬査読" }),
        h("option", { value: "strengthen-content", text: "内容の補強・拡張" }),
        h("option", { value: "proofread", text: "誤字・表現修正" }),
        h("option", { value: "literature-research", text: "文献調査支援" }),
      );
      const scopeSelect = h("select", { id: "assistant-scope", className: "select-input" },
        h("option", { value: "all", text: "原稿全体" }),
        h("option", { value: "section", text: "1つのセクション" }),
        h("option", { value: "selected-text", text: "貼り付けた範囲だけ" }),
        h("option", { value: "diagnostics", text: "診断結果だけ" }),
        h("option", { value: "metadata", text: "研究情報だけ" }),
      );
      const sectionSelect = h("select", { id: "assistant-section", className: "select-input" }, project.manuscript.sections.map((section) => h("option", { value: section.id, text: section.title, selected: section.id === project.ui.activeSectionId })));
      const runnerSelect = h("select", { id: "assistant-runner", className: "select-input" },
        h("option", { value: "generic", text: "汎用" }),
        h("option", { value: "ollama", text: "Ollama" }),
        h("option", { value: "qwen", text: "Qwen" }),
        h("option", { value: "codex", text: "Codex" }),
        h("option", { value: "claude-code", text: "Claude Code" }),
      );
      const strictnessSelect = h("select", { id: "assistant-strictness", className: "select-input" },
        h("option", { value: "light", text: "軽め" }),
        h("option", { value: "standard", text: "標準", selected: true }),
        h("option", { value: "strict", text: "厳格" }),
      );
      const englishVariantSelect = h("select", { id: "assistant-english-variant", className: "select-input" },
        h("option", { value: "american", text: "American English", selected: project.englishVariant !== "british" }),
        h("option", { value: "british", text: "British English", selected: project.englishVariant === "british" }),
      );
      const selectedText = h("textarea", { id: "assistant-selected-text", className: "text-area", maxLength: 50000, placeholder: "対象にしたい本文をここへ貼り付けます．" });
      const additionalRequest = h("textarea", { id: "assistant-additional", className: "text-area", maxLength: 5000, placeholder: "例：制御工学の査読者として，再現性を重点的に確認する" });
      const sectionField = field("対象セクション", sectionSelect);
      const selectionField = field("対象範囲の本文", selectedText, "この欄は「貼り付けた範囲だけ」を選んだときに使用します．");
      sectionField.hidden = true;
      selectionField.hidden = true;
      const updateScopeControls = () => {
        sectionField.hidden = scopeSelect.value !== "section";
        selectionField.hidden = scopeSelect.value !== "selected-text";
      };

      const promptOutput = h("textarea", { id: "assistant-prompt-output", className: "source-textarea prompt-output", readOnly: true, spellcheck: false, placeholder: "条件を選び，「プロンプトを作成」を押してください．" });
      const outputStatus = h("p", { className: "field-help", text: "まだ作成されていません．" });
      const warningBox = h("div", { className: "notice notice--warning", hidden: true });
      let lastGeneratedType = "";
      const copyButton = button("プロンプトをコピー", "button-secondary", async () => {
        try {
          await this.copyText(promptOutput.value, promptOutput);
          this.toast("プロンプトをコピーしました．");
        } catch (error) {
          this.toast(error.message, true);
        }
      }, { disabled: true });
      const downloadButton = button("テキスト保存", "button-secondary", () => {
        if (!promptOutput.value || !lastGeneratedType) return;
        PT.downloadBlob(new Blob([promptOutput.value], { type: "text/plain;charset=utf-8" }), `${PT.safeFilename(project.name, "paper")}-${lastGeneratedType}-prompt.txt`);
        this.toast("プロンプトを保存しました．");
      }, { disabled: true });
      const invalidatePrompt = () => {
        const hadPrompt = Boolean(promptOutput.value || lastGeneratedType);
        promptOutput.value = "";
        outputStatus.textContent = hadPrompt
          ? "条件が変更されました．プロンプトを作り直してください．"
          : "まだ作成されていません．";
        warningBox.replaceChildren();
        warningBox.hidden = true;
        copyButton.disabled = true;
        downloadButton.disabled = true;
        lastGeneratedType = "";
      };
      typeSelect.addEventListener("change", invalidatePrompt);
      projectSelect.addEventListener("change", (event) => {
        invalidatePrompt();
        this.navigate(`assistant/${encodeURIComponent(event.target.value)}`);
      });
      scopeSelect.addEventListener("change", () => {
        updateScopeControls();
        invalidatePrompt();
      });
      sectionSelect.addEventListener("change", invalidatePrompt);
      runnerSelect.addEventListener("change", invalidatePrompt);
      strictnessSelect.addEventListener("change", invalidatePrompt);
      englishVariantSelect.addEventListener("change", invalidatePrompt);
      selectedText.addEventListener("input", invalidatePrompt);
      additionalRequest.addEventListener("input", invalidatePrompt);
      const generate = () => {
        invalidatePrompt();
        try {
          const diagnostics = (project.manuscript.advice || []).slice();
          if (typeof PT.auditEvidence === "function") {
            const audited = PT.auditEvidence(project);
            const findings = Array.isArray(audited) ? audited : audited && (audited.findings || audited.items);
            if (Array.isArray(findings)) diagnostics.push(...findings.map((item) => ({
              severity: item.status === "missing" ? "required" : item.status === "recommended" ? "recommended" : "optional",
              title: item.title,
              reason: item.reason,
              target: item.targetSection,
              action: item.action,
              resolved: item.status === "ok",
            })));
          }
          const result = PT.createAiPrompt(project, {
            type: typeSelect.value,
            scope: scopeSelect.value,
            sectionId: sectionSelect.value,
            selectedText: selectedText.value,
            runner: runnerSelect.value,
            strictness: strictnessSelect.value,
            englishVariant: englishVariantSelect.value,
            additionalRequest: additionalRequest.value,
            diagnostics,
          });
          promptOutput.value = result.prompt;
          lastGeneratedType = result.type;
          outputStatus.textContent = `${result.label}・${result.promptChars.toLocaleString("ja-JP")}文字${result.truncated ? "・一部省略あり" : ""}`;
          warningBox.replaceChildren();
          if (result.warnings.length) {
            warningBox.hidden = false;
            warningBox.appendChild(h("strong", { text: "確認事項" }));
            warningBox.appendChild(h("ul", {}, result.warnings.map((message) => h("li", { text: message }))));
          } else {
            warningBox.hidden = true;
          }
          copyButton.disabled = false;
          downloadButton.disabled = false;
        } catch (error) {
          this.toast(`プロンプトを作成できませんでした：${error.message}`, true);
        }
      };

      const controls = h("section", { className: "panel assistant-controls" },
        h("h2", { text: "1．用途と対象を選ぶ" }),
        h("div", { className: "form-grid" },
          field("プロジェクト", projectSelect),
          field("機能", typeSelect),
          field("対象範囲", scopeSelect),
          sectionField,
          selectionField,
          field("使用先", runnerSelect, "接続先ではなく，プロンプトの想定先です．"),
          field("確認の厳しさ", strictnessSelect),
          field("英文表記", englishVariantSelect),
          field("追加の指示", additionalRequest, "研究データや未公開情報を含める前に，利用先の取扱いを確認してください．"),
        ),
        h("div", { className: "button-row", style: { marginTop: "18px" } }, button("プロンプトを作成", "button", generate), button("原稿を開く", "button-quiet", () => this.navigate(`editor/${encodeURIComponent(project.id)}`))),
      );
      const resultPanel = h("section", { className: "panel assistant-result" },
        h("h2", { text: "2．コピーして利用する" }),
        h("p", { text: "このアプリからAIへは送信しません．作成した指示文を確認し，自分でローカルLLMやコーディング支援ツールへ貼り付けます．" }),
        promptOutput,
        outputStatus,
        warningBox,
        h("div", { className: "button-row", style: { marginTop: "16px" } }, copyButton, downloadButton),
      );
      page.appendChild(h("div", { className: "notice assistant-privacy" }, h("strong", { text: "外部通信なし" }), h("p", { text: "APIキーは使わず，Ollama／Qwenへの自動接続も行いません．未確認の数値・文献を作らない指示と，返答形式を含むプロンプトだけを生成します．" })));
      page.appendChild(h("div", { className: "assistant-layout" }, controls, resultPanel));
    }

    renderSettings() {
      const page = this.page("設定", "保存・表記・バックアップの設定です．");
      const stack = h("div", { className: "settings-stack" });
      const punctuation = h("select", { id: "setting-punctuation", className: "select-input" }, h("option", { value: "ja-comma-period", text: "，．（学術向け）", selected: this.settings.punctuation === "ja-comma-period" }), h("option", { value: "ja-standard", text: "、。（一般的な日本語）", selected: this.settings.punctuation === "ja-standard" }));
      const englishVariant = h("select", { id: "setting-english-variant", className: "select-input" }, h("option", { value: "american", text: "American English", selected: this.settings.englishVariant !== "british" }), h("option", { value: "british", text: "British English", selected: this.settings.englishVariant === "british" }));
      const uploadLimit = h("input", { id: "setting-upload", className: "text-input", type: "number", min: 1, max: 50, value: this.settings.uploadLimitMb });
      const historyLimit = h("input", { id: "setting-history", className: "text-input", type: "number", min: 5, max: 100, value: this.settings.historyLimit });
      const save = async () => {
        this.settings = await this.repo.saveSettings(Object.assign({}, this.settings, { punctuation: punctuation.value, englishVariant: englishVariant.value === "british" ? "british" : "american", uploadLimitMb: Math.max(1, Math.min(50, Number(uploadLimit.value) || 10)), historyLimit: Math.max(5, Math.min(100, Number(historyLimit.value) || 20)), theme: "light" }));
        this.toast("設定を保存しました．");
      };
      stack.append(
        h("section", { className: "panel settings-panel" }, h("h2", { text: "文章と保存" }), h("p", { text: "設定はこのブラウザにのみ保存されます．新しく作るプロジェクトの既定値になります．" }), h("div", { className: "form-grid" }, field("日本語の句読点", punctuation), field("英語表記", englishVariant), field("1ファイルの上限（MB）", uploadLimit), field("履歴の保持件数", historyLimit)), h("div", { className: "button-row", style: { marginTop: "20px" } }, button("設定を保存", "button", save))),
        h("section", { className: "panel settings-panel" }, h("h2", { text: "AI支援の境界" }), h("p", { text: "APIキーは保存せず，OpenAI互換APIやOllamaへ自動接続しません．英文変換，模擬査読，内容補強，校正，文献調査は，AI作業台でプロンプトとして作成します．" }), h("div", { className: "notice", style: { marginTop: "16px" } }, h("strong", { text: "利用者が確認してコピー" }), h("p", { text: "研究データを自動送信する処理はありません．Codex，Claude Code，Ollama，Qwenなどへ貼り付ける前に内容を確認してください．" })), h("div", { className: "button-row", style: { marginTop: "16px" } }, button("AI作業台を開く", "button-secondary", () => this.navigate("assistant")))),
        h("section", { className: "panel settings-panel" }, h("h2", { text: "保存領域" }), h("p", { text: `現在：${this.repo.mode === "indexeddb" ? "IndexedDB（推奨）" : this.repo.mode === "localstorage" ? "localStorage（簡易）" : "メモリ（一時）"}` }), h("div", { className: "notice notice--warning", style: { marginTop: "16px" } }, h("p", { text: "ブラウザデータの消去や，file:// からGitHub Pagesへの移動では保存領域が変わります．添付を含む場合はZIP，本文だけならJSONを定期的に保存してください．" }))),
      );
      page.appendChild(stack);
    }

    showGuide() {
      this.dialog.returnValue = "cancel";
      this.dialogTitle.textContent = "paper_tools の使い方";
      this.dialogBody.replaceChildren(
        h("ol", {}, h("li", { text: "「テンプレート」で組込み構成を選ぶか，手元のテンプレートファイルを登録します．" }), h("li", { text: "「新規作成」で確認済みの目的・方法・結果だけを入力します．" }), h("li", { text: "生成された草稿のTODOと，右側の「助言」にある図・データ不足を確認します．" }), h("li", { text: "英文変換や模擬査読は「AI作業台」で指示文を作り，内容を確認して使用先へ貼り付けます．" }), h("li", { text: "編集後，ZIPバックアップと印刷PDFを保存します．" })),
        h("p", { text: "本文で参考文献を引用するときは，登録した引用キーの前に @ を付けます（例：@smith2026）．印刷PDFでは文献番号へ変換されます．" }),
        h("div", { className: "notice", style: { marginTop: "16px" } }, h("p", { text: "index.htmlはそのままダブルクリックで起動できます．Python，サーバー，APIキーは不要です．AI作業台も自動送信は行わず，プロンプトだけを生成します．" })),
      );
      this.dialogActions.replaceChildren(button("閉じる", "button", () => this.dialog.close("cancel")));
      this.dialog.showModal();
    }

    confirm(title, message, confirmLabel, destructive) {
      return new Promise((resolve) => {
        this.dialog.returnValue = "cancel";
        this.dialogTitle.textContent = title;
        this.dialogBody.replaceChildren(h("p", { text: message }));
        const cancel = button("キャンセル", "button-secondary", () => this.dialog.close("cancel"));
        const accept = button(confirmLabel, destructive ? "button-danger" : "button", () => this.dialog.close("confirm"));
        this.dialogActions.replaceChildren(cancel, accept);
        const onClose = () => {
          this.dialog.removeEventListener("close", onClose);
          this.dialog.removeEventListener("cancel", onCancel);
          resolve(this.dialog.returnValue === "confirm");
        };
        const onCancel = () => {
          this.dialog.returnValue = "cancel";
        };
        this.dialog.addEventListener("close", onClose);
        this.dialog.addEventListener("cancel", onCancel);
        this.dialog.showModal();
      });
    }

    toast(message, error) {
      const region = document.getElementById("toast-region");
      const item = h("div", { className: error ? "toast toast--error" : "toast", role: error ? "alert" : "status", text: message });
      region.appendChild(item);
      root.setTimeout(() => item.remove(), 4500);
    }

    renderFatal(error) {
      this.main.replaceChildren(
        h(
          "div",
          { className: "page" },
          h("div", { className: "notice notice--danger" }, h("strong", { text: "画面を表示できませんでした" }), h("p", { text: error && error.message ? error.message : "不明なエラーです．" })),
          button("ホームへ戻る", "button", () => this.navigate("home"), { style: { marginTop: "20px" } }),
        ),
      );
      console.error(error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const app = new PaperToolsApp();
    root.paperToolsApp = app;
    app.init().catch((error) => app.renderFatal(error));
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
