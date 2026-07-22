"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const APP_READY_TIMEOUT_MS = 20_000;
const DEVTOOLS_TIMEOUT_MS = 10_000;
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
      }, 5_000);
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
    process.stdout.write(
      `Browser smoke test passed (${path.basename(browserExecutable)}): ${JSON.stringify(state)}\n`,
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
