(function (root) {
  "use strict";
  const list = document.getElementById("results");
  const summary = document.getElementById("summary");
  root.PaperToolsTestSuite.run((result) => {
    const item = document.createElement("li");
    item.className = result.ok ? "pass" : "fail";
    item.textContent = `${result.ok ? "成功" : "失敗"}：${result.name}（${result.durationMs} ms）`;
    if (!result.ok) {
      const details = document.createElement("code");
      details.textContent = `\n${result.error.stack || result.error.message}`;
      item.appendChild(details);
    }
    list.appendChild(item);
  }).then((results) => {
    const failed = results.filter((item) => !item.ok).length;
    summary.textContent = failed ? `${failed}件のテストが失敗しました．` : `${results.length}件すべて成功しました．`;
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
