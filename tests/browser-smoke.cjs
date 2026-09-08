"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const APP_READY_TIMEOUT_MS = 20_000;
const DEVTOOLS_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function browserArgument() {
  const browserFlag = process.argv.indexOf("--browser");
  if (browserFlag >= 0) {
    const value = process.argv[browserFlag + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--browser にはブラウザー実行ファイルを指定してください．");
    }
    return value;
  }

  if (process.env.PAPER_TOOLS_BROWSER) {
    return process.env.PAPER_TOOLS_BROWSER;
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];

  const discovered = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!discovered) {
    throw new Error(
      "Chrome または Edge が見つかりません．--browser <実行ファイル> か PAPER_TOOLS_BROWSER を指定してください．",
    );
  }
  return discovered;
}

async function waitForDevTools(profileDirectory, browserState) {
  const activePortFile = path.join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + DEVTOOLS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (browserState.launchError) {
      throw browserState.launchError;
    }
    if (browserState.exited) {
      throw new Error(`ブラウザーが準備前に終了しました (${browserState.exited}).`);
    }
    try {
      const [portLine] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
      const port = Number.parseInt(portLine, 10);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("Chrome DevTools Protocol の起動を待機しましたが，タイムアウトしました．");
}

async function waitForPageTarget(port, expectedUrl, browserState) {
  const deadline = Date.now() + DEVTOOLS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (browserState.exited) {
      throw new Error(`ブラウザーがページ読込前に終了しました (${browserState.exited}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const exactTarget = targets.find(
          (target) => target.type === "page" && target.url === expectedUrl && target.webSocketDebuggerUrl,
        );
        const appTarget = exactTarget || targets.find(
          (target) => target.type === "page" && target.url.startsWith(expectedUrl.split("#")[0]) && target.webSocketDebuggerUrl,
        );
        if (appTarget) {
          return appTarget;
        }
      }
    } catch {
      // DevTools の HTTP endpoint が応答可能になるまで実時間で待つ．
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("アプリの DevTools page target を取得できませんでした．");
}

class CdpSession {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 接続がタイムアウトしました．")), 5_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket に接続できませんでした．"));
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        resolve(message.result);
      }
    });
  }

  command(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} がタイムアウトしました．`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP セッションを終了しました．"));
    }
    this.pending.clear();
    this.socket.close();
  }
}

async function waitForApplication(session) {
  const expression = String.raw`(() => {
    const text = document.body?.innerText || "";
    const state = {
      readyState: document.readyState,
      initialLoadingRemoved: !document.getElementById("initial-loading"),
      hasHero: text.includes("研究内容を，論文のかたちへ．"),
      hasNewProjectButton: text.includes("新しい論文を作る"),
      bodyPreview: text.slice(0, 500),
    };
    return {
      ...state,
      ready: state.readyState !== "loading"
        && state.initialLoadingRemoved
        && state.hasHero
        && state.hasNewProjectButton,
    };
  })()`;
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let lastState = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const evaluation = await session.command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      lastState = evaluation.result?.value || null;
      lastError = null;
      if (lastState?.ready) {
        return lastState;
      }
    } catch (error) {
      // Navigation during startup can replace the execution context; retry it.
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }

  const diagnostic = lastState ? JSON.stringify(lastState) : String(lastError || "状態を取得できませんでした");
  throw new Error(`アプリが ${APP_READY_TIMEOUT_MS / 1000} 秒以内に準備完了しませんでした: ${diagnostic}`);
}

async function waitForRoute(session, hash, marker) {
  await session.command("Runtime.evaluate", {
    expression: `location.hash = ${JSON.stringify(hash)}; true`,
    returnByValue: true,
  });
  const expression = `(() => {
    const text = document.body?.innerText || "";
    return {
      hash: location.hash,
      markerFound: text.includes(${JSON.stringify(marker)}),
      fatal: text.includes("画面を表示できませんでした"),
      bodyPreview: text.slice(0, 500),
    };
  })()`;
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let lastState = null;

  while (Date.now() < deadline) {
    try {
      const evaluation = await session.command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      lastState = evaluation.result?.value || null;
      if (lastState?.fatal) {
        throw new Error(`${hash} の表示中にアプリ内エラーが発生しました: ${JSON.stringify(lastState)}`);
      }
      if (lastState?.hash === hash && lastState.markerFound) return lastState;
    } catch (error) {
      if (error.message.includes("アプリ内エラー")) throw error;
      // 画面切替中に実行コンテキストが変わった場合は再試行する．
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`${hash} を表示できませんでした: ${JSON.stringify(lastState)}`);
}

async function waitForEvaluation(session, expression, isReady, description) {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const evaluation = await session.command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      lastState = evaluation.result?.value || null;
      if (isReady(lastState)) return lastState;
    } catch {
      // 非同期再描画中に実行コンテキストが変わった場合は再試行する．
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${description}: ${JSON.stringify(lastState)}`);
}

function safeRemoveProfile(profileDirectory) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolvedProfile = path.resolve(profileDirectory);
  const expectedPrefix = `${temporaryRoot}${path.sep}paper-tools-browser-smoke-`;
  if (!resolvedProfile.startsWith(expectedPrefix)) {
    throw new Error(`一時プロファイル以外は削除しません: ${resolvedProfile}`);
  }
  try {
    fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows では終了直後のブラウザー子プロセスがファイルを保持することがある．
  }
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket が利用できません．Node.js 20 では --experimental-websocket を付けて実行してください．");
  }

  const browserExecutable = browserArgument();
  const indexPath = path.resolve(__dirname, "..", "index.html");
  const appUrl = `${pathToFileURL(indexPath).href}#home`;
  const setupUrl = pathToFileURL(
    path.resolve(__dirname, "..", "docs", "cloud-sync-setup.html"),
  ).href;
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-tools-browser-smoke-"));
  const browserState = { launchError: null, exited: null };
  let stderr = "";
  let session = null;

  const browser = spawn(browserExecutable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--remote-allow-origins=*",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    appUrl,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  const browserExit = new Promise((resolve) => {
    browser.once("exit", (code, signal) => {
      browserState.exited = signal ? `signal ${signal}` : `exit code ${code}`;
      resolve();
    });
  });
  browser.once("error", (error) => {
    browserState.launchError = error;
  });
  browser.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  try {
    const port = await waitForDevTools(profileDirectory, browserState);
    const target = await waitForPageTarget(port, appUrl, browserState);
    session = new CdpSession(target.webSocketDebuggerUrl);
    await session.open();
    const state = await waitForApplication(session);
    const routes = [];
    routes.push(await waitForRoute(session, "#cloud", "現在は端末内だけで保存しています"));
    routes.push(await waitForRoute(session, "#templates", "テンプレートを自動登録"));
    await session.command("Runtime.evaluate", {
      expression: `(() => {
        const input = document.getElementById("template-import-input");
        const dispatchTemplate = (name, source) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([source], name, { type: "text/markdown" }));
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        dispatchTemplate(
          "smoke-template.md",
          "# Smoke Template\\n## Abstract\\n## Method\\n## Results\\n## References",
        );
        dispatchTemplate(
          "racing-template.md",
          "# Racing Template\\n## Introduction\\n## Conclusion",
        );
        return true;
      })()`,
      returnByValue: true,
    });
    routes.push(await waitForRoute(session, "#templates", "Smoke Template"));
    const templateRegistration = await waitForEvaluation(
      session,
      `(() => {
        const custom = PaperTools.listCustomTemplates();
        return {
          customCount: custom.length,
          expectedRegistered: custom.some((item) => item.name === "Smoke Template"),
          concurrentRejected: !custom.some((item) => item.name === "Racing Template"),
        };
      })()`,
      (value) => Boolean(value && value.customCount === 1 && value.expectedRegistered && value.concurrentRejected),
      "テンプレート登録の排他制御を確認できませんでした",
    );

    const projectEvaluation = await session.command("Runtime.evaluate", {
      expression: `(async () => {
        const repository = new PaperTools.Repository();
        await repository.init();
        const project = PaperTools.createProject("generic-ja", { title: "UI smoke paper" });
        project.name = "UI smoke project";
        project.research.objective = "ブラウザー統合確認";
        project.manuscript.sections[0].content = "これは英文変換対象の日本語本文です．";
        await repository.saveProject(project);
        const secondProject = PaperTools.createProject("generic-ja", { title: "Second UI smoke paper" });
        secondProject.name = "Second UI smoke project";
        await repository.saveProject(secondProject);
        return { primaryId: project.id, secondaryId: secondProject.id };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const projectIds = projectEvaluation.result?.value;
    if (!projectIds?.primaryId || !projectIds?.secondaryId) throw new Error("ブラウザースモーク用プロジェクトを作成できませんでした．");

    routes.push(await waitForRoute(
      session,
      `#editor/${encodeURIComponent(projectIds.primaryId)}`,
      "章構成を編集",
    ));
    const outlineOpenEvaluation = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = document.getElementById("open-chapter-outline");
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!outlineOpenEvaluation.result?.value) {
      throw new Error("章構成パネルを開く操作を開始できませんでした．");
    }
    await waitForEvaluation(
      session,
      `(() => ({
        hasOutline: Boolean(document.getElementById("chapter-outline")),
        hasAddButton: Boolean(document.getElementById("add-chapter")),
      }))()`,
      (value) => Boolean(value && value.hasOutline && value.hasAddButton),
      "章構成パネルを表示できませんでした",
    );

    const addChapterEvaluation = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = document.getElementById("add-chapter");
        if (!trigger) return null;
        trigger.click();
        const panel = document.querySelector(".chapter-contract-panel");
        return {
          chapterId: panel?.dataset?.chapterId || "",
          initialProgress: document.getElementById("chapter-contract-progress")?.textContent || "",
        };
      })()`,
      returnByValue: true,
    });
    const addedChapter = addChapterEvaluation.result?.value;
    if (!addedChapter?.chapterId || addedChapter.initialProgress !== "0/8項目を入力済み") {
      throw new Error(`章を追加して空の論証契約を開けませんでした: ${JSON.stringify(addedChapter)}`);
    }
    const chapterId = addedChapter.chapterId;
    const chapterTitle = "ブラウザー章構成テスト";
    const centralQuestion = "SMOKE_CENTRAL_RESEARCH_QUESTION";
    const contractProblem = "SMOKE_CHAPTER_PROBLEM";
    const contractHypothesis = "SMOKE_CHAPTER_HYPOTHESIS";
    const contractLimitations = "SMOKE_CHAPTER_LIMITATIONS";
    const chapterInputEvaluation = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const setInput = (control, value) => {
          if (!control) return false;
          control.value = value;
          control.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        const changed = [
          setInput(document.getElementById(${JSON.stringify(`outline-title-${chapterId}`)}), ${JSON.stringify(chapterTitle)}),
          setInput(document.getElementById("central-research-question"), ${JSON.stringify(centralQuestion)}),
          setInput(document.getElementById("chapter-contract-problem"), ${JSON.stringify(contractProblem)}),
          setInput(document.getElementById("chapter-contract-hypothesis"), ${JSON.stringify(contractHypothesis)}),
          setInput(document.getElementById("chapter-contract-limitations"), ${JSON.stringify(contractLimitations)}),
        ];
        return {
          allInputsFound: changed.every(Boolean),
          progress: document.getElementById("chapter-contract-progress")?.textContent || "",
          title: document.getElementById(${JSON.stringify(`outline-title-${chapterId}`)})?.value || "",
        };
      })()`,
      returnByValue: true,
    });
    const chapterInput = chapterInputEvaluation.result?.value;
    if (!chapterInput?.allInputsFound || chapterInput.progress !== "3/8項目を入力済み" || chapterInput.title !== chapterTitle) {
      throw new Error(`章名・論証契約・進捗を更新できませんでした: ${JSON.stringify(chapterInput)}`);
    }
    const chapterSaveEvaluation = await session.command("Runtime.evaluate", {
      expression: `(async () => {
        const app = window.paperToolsApp;
        const completed = await app.flushPendingSaves();
        const stored = await app.repo.getProject(${JSON.stringify(projectIds.primaryId)});
        const chapter = stored?.manuscript?.sections?.find((item) => item.id === ${JSON.stringify(chapterId)});
        return {
          completed,
          storedTitle: chapter?.title || "",
          storedProgress: chapter ? PaperTools.chapterContractProgress(chapter).completed : -1,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const chapterOutline = chapterSaveEvaluation.result?.value;
    if (!chapterOutline?.completed || chapterOutline.storedTitle !== chapterTitle || chapterOutline.storedProgress !== 3) {
      throw new Error(`章構成を端末へ保存できませんでした: ${JSON.stringify(chapterOutline)}`);
    }

    const deepenNavigationEvaluation = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = document.querySelector('.chapter-contract-panel [data-action="deepen-chapter"]');
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!deepenNavigationEvaluation.result?.value) {
      throw new Error("章の深掘りプロンプト画面へ移動できませんでした．");
    }
    const chapterAssistantHash = `#assistant/${encodeURIComponent(projectIds.primaryId)}/${encodeURIComponent(chapterId)}`;
    await waitForEvaluation(
      session,
      `(() => ({
        hash: location.hash,
        type: document.getElementById("assistant-type")?.value || "",
        scope: document.getElementById("assistant-scope")?.value || "",
        scopeDisabled: Boolean(document.getElementById("assistant-scope")?.disabled),
        sectionId: document.getElementById("assistant-section")?.value || "",
      }))()`,
      (value) => Boolean(
        value
        && value.hash === chapterAssistantHash
        && value.type === "deepen-chapter"
        && value.scope === "section"
        && value.scopeDisabled
        && value.sectionId === chapterId
      ),
      "選択章を引き継いだ深掘りプロンプト画面を表示できませんでした",
    );
    await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = Array.from(document.querySelectorAll(".assistant-controls button"))
          .find((item) => item.textContent.trim() === "プロンプトを作成");
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    });
    const chapterPrompt = await waitForEvaluation(
      session,
      `(() => {
        const output = document.getElementById("assistant-prompt-output")?.value || "";
        const startMarker = "## SOURCE_DATA_JSON_BEGIN\\n";
        const endMarker = "\\n## SOURCE_DATA_JSON_END";
        const start = output.indexOf(startMarker);
        const end = output.lastIndexOf(endMarker);
        let source = null;
        try {
          source = start >= 0 && end > start
            ? JSON.parse(output.slice(start + startMarker.length, end))
            : null;
        } catch (_error) {
          source = null;
        }
        const disclosedChapter = source?.manuscriptSections?.[0];
        return {
          promptChars: output.length,
          task: output.includes('"task": "deepen-chapter"'),
          type: document.getElementById("assistant-type")?.value || "",
          scope: document.getElementById("assistant-scope")?.value || "",
          sectionId: document.getElementById("assistant-section")?.value || "",
          sourceKeys: source ? Object.keys(source).sort().join(",") : "",
          projectKeys: source?.project ? Object.keys(source.project).sort().join(",") : "",
          sectionCount: source?.manuscriptSections?.length ?? -1,
          disclosedId: disclosedChapter?.id || "",
          disclosedTitle: disclosedChapter?.title || "",
          disclosedProblem: disclosedChapter?.chapterContract?.problem || "",
          disclosedHypothesis: disclosedChapter?.chapterContract?.hypothesis || "",
          disclosedLimitations: disclosedChapter?.chapterContract?.limitations || "",
          disclosedCentralQuestion: source?.project?.centralResearchQuestion || "",
          leakedOtherChapter: output.includes("これは英文変換対象の日本語本文です．"),
          leakedProjectTitle: output.includes("UI smoke paper"),
        };
      })()`,
      (value) => Boolean(
        value
        && value.promptChars > 500
        && value.task
        && value.type === "deepen-chapter"
        && value.scope === "section"
        && value.sectionId === chapterId
        && value.sourceKeys === "manuscriptSections,project,sourcePolicy"
        && value.projectKeys === "centralResearchQuestion"
        && value.sectionCount === 1
        && value.disclosedId === chapterId
        && value.disclosedTitle === chapterTitle
        && value.disclosedProblem === contractProblem
        && value.disclosedHypothesis === contractHypothesis
        && value.disclosedLimitations === contractLimitations
        && value.disclosedCentralQuestion === centralQuestion
        && !value.leakedOtherChapter
        && !value.leakedProjectTitle
      ),
      "章深掘りプロンプトの対象・契約・最小開示を確認できませんでした",
    );

    routes.push(await waitForRoute(
      session,
      `#editor/${encodeURIComponent(projectIds.primaryId)}`,
      "章構成を編集",
    ));
    await session.command("Page.reload", { ignoreCache: true });
    await waitForEvaluation(
      session,
      `(() => ({
        hash: location.hash,
        ready: Boolean(window.paperToolsApp?.currentProject?.id === ${JSON.stringify(projectIds.primaryId)}),
        hasOutlineButton: Boolean(document.getElementById("open-chapter-outline")),
      }))()`,
      (value) => Boolean(
        value
        && value.hash === `#editor/${encodeURIComponent(projectIds.primaryId)}`
        && value.ready
        && value.hasOutlineButton
      ),
      "再読み込み後に章プロジェクトを開けませんでした",
    );
    const chapterPersistence = await waitForEvaluation(
      session,
      `(async () => {
        try {
          const app = window.paperToolsApp;
          const stored = await app.repo.getProject(${JSON.stringify(projectIds.primaryId)});
          const chapter = stored?.manuscript?.sections?.find((item) => item.id === ${JSON.stringify(chapterId)});
          document.getElementById("open-chapter-outline")?.click();
          const row = Array.from(document.querySelectorAll(".outline-row"))
            .find((item) => item.dataset.chapterId === ${JSON.stringify(chapterId)});
          row?.querySelector('[data-chapter-action="open-contract"]')?.click();
          return {
            stored: Boolean(chapter),
            outlineCustomized: Boolean(stored?.manuscript?.outlineCustomized),
            title: chapter?.title || "",
            progress: chapter ? PaperTools.chapterContractProgress(chapter).completed : -1,
            visibleProgress: document.getElementById("chapter-contract-progress")?.textContent || "",
            centralQuestion: document.getElementById("central-research-question")?.value || "",
            problem: document.getElementById("chapter-contract-problem")?.value || "",
            hypothesis: document.getElementById("chapter-contract-hypothesis")?.value || "",
            limitations: document.getElementById("chapter-contract-limitations")?.value || "",
          };
        } catch (error) {
          return { error: error?.stack || error?.message || String(error) };
        }
      })()`,
      (value) => Boolean(
        value
        && value.stored
        && value.outlineCustomized
        && value.title === chapterTitle
        && value.progress === 3
        && value.visibleProgress === "3/8項目を入力済み"
        && value.centralQuestion === centralQuestion
        && value.problem === contractProblem
        && value.hypothesis === contractHypothesis
        && value.limitations === contractLimitations
      ),
      "再読み込み後に章構成を復元できませんでした",
    );

    await session.command("Runtime.evaluate", {
      expression: `(() => {
        const app = window.paperToolsApp;
        const owner = {
          id: "11111111-1111-4111-8111-111111111111",
          email: "smoke@example.org",
        };
        const remotes = new Map();
        const copy = (value) => structuredClone(value);
        window.PAPER_TOOLS_CLOUD = { enabled: true };
        app.cloudError = "";
        app.cloudStatus = { enabled: true, ready: true };
        app.setCloudSession({ signedIn: true, user: owner, expiresAt: null });
        app.cloudProjects = [];
        app.cloud = {
          async listProjects() {
            return Array.from(remotes.values()).map(copy);
          },
          async getProject(id) {
            const row = remotes.get(id);
            return row ? copy(row) : null;
          },
          async saveProject(project, options) {
            const safe = PaperTools.sanitizeProjectForCloud(project);
            const expected = options?.expectedRevision ?? 0;
            const prior = remotes.get(safe.id);
            if ((!prior && expected !== 0) || (prior && expected !== prior.revision)) {
              const error = new Error("revision conflict");
              error.code = "revision-conflict";
              throw error;
            }
            const now = new Date().toISOString();
            const row = {
              id: safe.id,
              cloudId: prior?.cloudId || "22222222-2222-4222-8222-222222222222",
              revision: prior ? prior.revision + 1 : 1,
              project: safe,
              createdAt: prior?.createdAt || now,
              updatedAt: now,
            };
            remotes.set(safe.id, row);
            return copy(row);
          },
          async uploadAttachment() {
            throw new Error("添付なしのUIスモークでuploadが呼ばれました");
          },
          async downloadAttachment() {
            throw new Error("添付なしのUIスモークでdownloadが呼ばれました");
          },
          async signOut() {
            return { signedIn: false, user: null, expiresAt: null };
          },
        };
        app.updatePrivacyMode();
        window.__paperToolsCloudSmoke = { owner, remotes };
        location.hash = "#cloud";
        return true;
      })()`,
      returnByValue: true,
    });
    routes.push(await waitForRoute(session, "#cloud", "クラウドへコピー"));
    await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = Array.from(document.querySelectorAll("button"))
          .find((item) => item.textContent.trim() === "クラウドへコピー");
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    });
    const cloudUi = await waitForEvaluation(
      session,
      `(async () => {
        const smoke = window.__paperToolsCloudSmoke;
        const metadata = await window.paperToolsApp.repo.listSyncMeta(smoke.owner.id);
        return {
          synced: (document.body?.innerText || "").includes("同期済み"),
          remoteCount: smoke.remotes.size,
          metaCount: metadata.length,
          pendingCount: (await window.paperToolsApp.repo.listSyncOutbox(smoke.owner.id)).length,
        };
      })()`,
      (value) => Boolean(value && value.synced && value.remoteCount === 1 && value.metaCount === 1 && value.pendingCount === 0),
      "クラウド同期UIの新規保存とsidecar更新を確認できませんでした",
    );
    await session.command("Runtime.evaluate", {
      expression: `(async () => {
        const app = window.paperToolsApp;
        const smoke = window.__paperToolsCloudSmoke;
        const [remote] = smoke.remotes.values();
        const local = await app.repo.getProject(remote.id);
        local.research.notes = "端末側の競合変更";
        await app.repo.saveProject(local);
        remote.project.research.notes = "クラウド側の競合変更";
        remote.revision += 1;
        remote.updatedAt = new Date().toISOString();
        await app.renderRoute();
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const cloudConflict = await waitForEvaluation(
      session,
      `(() => ({
        conflictShown: (document.body?.innerText || "").includes("両方に変更"),
        fatal: (document.body?.innerText || "").includes("画面を表示できませんでした"),
      }))()`,
      (value) => Boolean(value && value.conflictShown && !value.fatal),
      "クラウド同期UIの競合停止を確認できませんでした",
    );
    const cloudIdentityEvaluation = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const app = window.paperToolsApp;
        const smoke = window.__paperToolsCloudSmoke;
        const identity = app.captureCloudIdentity();
        const initialEpoch = app.cloudAuthEpoch;
        app.cloudProjects = [{ id: "must-be-cleared" }];
        app.setCloudSession({
          signedIn: true,
          user: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            email: "other@example.org",
          },
          expiresAt: null,
        });
        let rejected = false;
        try {
          app.assertCloudIdentity(identity);
        } catch (error) {
          rejected = error?.code === "cloud-auth-changed";
        }
        const result = {
          cacheCleared: app.cloudProjects.length === 0,
          epochAdvanced: app.cloudAuthEpoch > initialEpoch,
          staleIdentityRejected: rejected,
        };
        app.setCloudSession({ signedIn: true, user: smoke.owner, expiresAt: null });
        return result;
      })()`,
      returnByValue: true,
    });
    const cloudIdentity = cloudIdentityEvaluation.result?.value;
    if (
      !cloudIdentity?.cacheCleared
      || !cloudIdentity?.epochAdvanced
      || !cloudIdentity?.staleIdentityRejected
    ) {
      throw new Error(`クラウド認証owner境界を確認できませんでした: ${JSON.stringify(cloudIdentity)}`);
    }

    routes.push(await waitForRoute(session, `#assistant/${encodeURIComponent(projectIds.primaryId)}`, "1．用途と対象を選ぶ"));
    await session.command("Runtime.evaluate", {
      expression: `(() => {
        const trigger = Array.from(document.querySelectorAll("button"))
          .find((item) => item.textContent.trim() === "プロンプトを作成");
        if (!trigger) return false;
        trigger.click();
        return true;
      })()`,
      returnByValue: true,
    });
    const prompt = await waitForEvaluation(
      session,
      `(() => {
        const output = document.getElementById("assistant-prompt-output");
        return {
          promptChars: output?.value?.length || 0,
          hasContract: Boolean(output?.value?.includes('"task": "translate-english"')),
          fatal: (document.body?.innerText || "").includes("画面を表示できませんでした"),
        };
      })()`,
      (value) => Boolean(value && !value.fatal && value.promptChars > 500 && value.hasContract),
      "AI作業台でプロンプトを生成できませんでした",
    );
    const immediateSwitch = await session.command("Runtime.evaluate", {
      expression: `(() => {
        const select = document.getElementById("assistant-project");
        const output = document.getElementById("assistant-prompt-output");
        select.value = ${JSON.stringify(projectIds.secondaryId)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return { promptChars: output.value.length, hash: location.hash };
      })()`,
      returnByValue: true,
    });
    if (immediateSwitch.result?.value?.promptChars !== 0) {
      throw new Error(`プロジェクト変更時に古いプロンプトが残りました: ${JSON.stringify(immediateSwitch.result?.value)}`);
    }
    routes.push(await waitForRoute(session, `#assistant/${encodeURIComponent(projectIds.secondaryId)}`, "1．用途と対象を選ぶ"));
    const projectSwitch = await waitForEvaluation(
      session,
      `(() => {
        const select = document.getElementById("assistant-project");
        const output = document.getElementById("assistant-prompt-output");
        return { selectedProject: select?.value || "", promptChars: output?.value?.length || 0 };
      })()`,
      (value) => Boolean(value && value.selectedProject === projectIds.secondaryId && value.promptChars === 0),
      "AI作業台のプロジェクト変更を確認できませんでした",
    );
    await session.command("Page.navigate", { url: setupUrl });
    const setupPage = await waitForEvaluation(
      session,
      `(() => ({
        title: document.title,
        hasQuickSteps: (document.body?.innerText || "").includes("管理者が最初に一度だけ設定します"),
        hasSecretWarning: (document.body?.innerText || "").includes("Secret key"),
        readyState: document.readyState,
      }))()`,
      (value) => Boolean(
        value
        && value.readyState === "complete"
        && value.hasQuickSteps
        && value.hasSecretWarning
      ),
      "クラウド同期のHTML初期設定ページを表示できませんでした",
    );
    process.stdout.write(
      `Browser smoke test passed (${path.basename(browserExecutable)}): ${JSON.stringify({ home: state, routes, templateRegistration, chapterOutline, chapterPrompt, chapterPersistence, cloudUi, cloudConflict, cloudIdentity, prompt, projectSwitch, setupPage })}\n`,
    );
  } catch (error) {
    if (stderr.trim()) {
      error.message = `${error.message}\nBrowser stderr:\n${stderr.trim()}`;
    }
    throw error;
  } finally {
    if (session) {
      session.close();
    }
    if (!browserState.exited) {
      browser.kill();
      await Promise.race([browserExit, delay(2_000)]);
    }
    safeRemoveProfile(profileDirectory);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
