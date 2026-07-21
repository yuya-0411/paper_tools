"use strict";

document.addEventListener("alpine:init", () => {
  window.Alpine.data("wizard", () => ({
    step: 1,
    total: 5,
    detailed: false,
    draftStatus: "未保存",
    draftKey: "paper-tools:new-project-draft:v1",
    init() {
      try {
        const draft = JSON.parse(window.localStorage.getItem(this.draftKey) || "null");
        if (draft && draft.values) {
          this.step = Math.min(this.total, Math.max(1, Number(draft.step) || 1));
          window.requestAnimationFrame(() => this.restoreValues(draft.values));
          this.draftStatus = "端末内の下書きを復元しました";
        }
      } catch (_error) {
        this.draftStatus = "下書きを復元できませんでした";
      }
      this.$root.addEventListener("input", () => this.saveDraft());
      this.$root.addEventListener("change", () => this.saveDraft());
    },
    next() {
      if (this.step < this.total) this.step += 1;
      this.saveDraft();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    previous() {
      if (this.step > 1) this.step -= 1;
      this.saveDraft();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    validateBeforeSubmit(event) {
      const invalid = Array.from(this.$root.elements).find(
        (field) => typeof field.checkValidity === "function" && !field.checkValidity(),
      );
      if (!invalid) return;
      event.preventDefault();
      const section = invalid.closest("[data-wizard-step]");
      if (section) this.step = Number(section.dataset.wizardStep);
      this.$nextTick(() => {
        invalid.focus();
        invalid.reportValidity();
      });
    },
    saveDraft() {
      const values = {};
      for (const [name, value] of new window.FormData(this.$root).entries()) {
        if (name === "csrf_token" || value instanceof window.File) continue;
        if (!values[name]) values[name] = [];
        values[name].push(value);
      }
      try {
        window.localStorage.setItem(
          this.draftKey,
          JSON.stringify({ step: this.step, values }),
        );
        this.draftStatus = "この端末に途中保存済み";
      } catch (_error) {
        this.draftStatus = "途中保存に失敗しました";
      }
    },
    clearDraft() {
      window.localStorage.removeItem(this.draftKey);
      this.draftStatus = "途中保存を削除しました";
    },
    restoreValues(values) {
      for (const [name, saved] of Object.entries(values)) {
        const fields = Array.from(this.$root.querySelectorAll(`[name="${window.CSS.escape(name)}"]`));
        fields.forEach((field, index) => {
          if (field.type === "checkbox" || field.type === "radio") {
            field.checked = saved.includes(field.value);
            field.dispatchEvent(new window.Event("change", { bubbles: true }));
          } else if (saved[index] !== undefined) {
            field.value = saved[index];
            field.dispatchEvent(new window.Event("input", { bubbles: true }));
          }
        });
      }
    },
  }));

  window.Alpine.data("authorRows", (initialAuthors = null) => ({
    authors: [],
    init() {
      let source = Array.isArray(initialAuthors) ? initialAuthors : null;
      if (!source) {
        try {
          const draft = JSON.parse(
            window.localStorage.getItem("paper-tools:new-project-draft:v1") || "null",
          );
          const values = draft?.values || {};
          const count = Math.max(
            values.author_name?.length || 0,
            values.author_affiliation?.length || 0,
            values.author_email?.length || 0,
            values.author_orcid?.length || 0,
          );
          if (count > 0) {
            const corresponding = new Set(values.author_corresponding || []);
            source = Array.from({ length: count }, (_, index) => ({
              name: values.author_name?.[index] || "",
              affiliation: values.author_affiliation?.[index] || "",
              email: values.author_email?.[index] || "",
              orcid: values.author_orcid?.[index] || "",
              corresponding: corresponding.has(String(index)),
            }));
          }
        } catch (_error) {
          source = null;
        }
      }
      this.authors = (source?.length ? source : [this.emptyAuthor(true)]).map(
        (author) => ({ ...this.emptyAuthor(), ...author, _key: this.newKey() }),
      );
    },
    newKey() {
      if (typeof window.crypto?.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      return `author-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    },
    emptyAuthor(corresponding = false) {
      return { name: "", affiliation: "", email: "", orcid: "", corresponding };
    },
    add() {
      this.authors.push({ ...this.emptyAuthor(), _key: this.newKey() });
    },
    remove(index) {
      if (this.authors.length > 1) this.authors.splice(index, 1);
    },
    move(index, offset) {
      const target = index + offset;
      if (target < 0 || target >= this.authors.length) return;
      const [author] = this.authors.splice(index, 1);
      this.authors.splice(target, 0, author);
    },
  }));

  window.Alpine.data("editorShell", () => ({
    rightTab: "preview",
    mobilePanel: "document",
    sourceMode: false,
  }));
});

document.addEventListener("DOMContentLoaded", () => {
  const url = new URL(window.location.href);
  if (url.searchParams.get("created") !== "1") return;
  window.localStorage.removeItem("paper-tools:new-project-draft:v1");
  url.searchParams.delete("created");
  const query = url.searchParams.toString();
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
  );
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(
    "form[data-selection-transform] button[type='submit']",
  );
  if (!button) return;
  const form = button.closest("form[data-selection-transform]");
  const textarea = document.getElementById(form.dataset.selectionSource);
  const start = textarea?.selectionStart ?? 0;
  const end = textarea?.selectionEnd ?? 0;
  if (!textarea || end <= start || !textarea.value.slice(start, end).trim()) {
    event.preventDefault();
    const region = document.getElementById("global-message");
    if (region) {
      region.hidden = false;
      region.textContent = "本文欄で変換する文章を選択してください．";
      region.focus();
    }
    textarea?.focus();
    return;
  }
  form.elements.selection_start.value = String(start);
  form.elements.selection_end.value = String(end);
  form.elements.selected_text.value = textarea.value.slice(start, end);
});

document.addEventListener("htmx:beforeRequest", (event) => {
  const form = event.target.closest("form[data-save-status]");
  if (!form) return;
  const status = document.getElementById(form.dataset.saveStatus);
  if (status) {
    status.textContent = "保存中…";
    status.dataset.state = "saving";
  }
});

document.addEventListener("htmx:afterRequest", (event) => {
  const form = event.target.closest("form[data-save-status]");
  if (!form) return;
  const status = document.getElementById(form.dataset.saveStatus);
  if (!status) return;
  const ok = event.detail.successful;
  status.textContent = ok ? "保存済み" : "保存に失敗しました";
  status.dataset.state = ok ? "saved" : "failed";
});

document.addEventListener("htmx:responseError", (event) => {
  const message = event.detail.xhr.responseText || "操作に失敗しました．";
  const region = document.getElementById("global-message");
  if (region) {
    region.hidden = false;
    region.textContent = message;
    region.focus();
  }
});

document.addEventListener("paperSectionChanged", (event) => {
  const selected = String(event.detail?.section || "");
  for (const link of document.querySelectorAll("[data-section-slug]")) {
    link.classList.toggle("active", link.dataset.sectionSlug === selected);
  }
});
