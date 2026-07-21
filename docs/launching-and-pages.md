# ワンクリック起動とGitHub Pagesの境界

## Windowsでの起動

通常利用者はリポジトリ直下の `START_PAPER_TOOLS.cmd` をダブルクリックする．このファイルはPython 3.11以上を確認し，リポジトリ専用の `.paper-tools-venv` を初回だけ作成してから `paper-tools launch` を実行する．依存関係を定める `pyproject.toml` または `uv.lock` が変わった場合だけ環境を更新する．既存の開発用 `.venv` には触れない．

`paper-tools launch` は `/healthz` のアプリ識別応答を確認する．同じポートでpaper_toolsが既に動いていれば新しいサーバーを増やさず，既存画面を開く．未起動ならUvicornを前景で開始し，準備完了を確認してから既定ブラウザを開く．固定秒数だけ待つ方式ではない．

起動中のコンソールを閉じるか `Ctrl+C` を入力するとローカルサーバーを停止できる．原稿データは既定でWindowsのユーザー固有アプリデータディレクトリへ保存されるため，起動専用環境を作り直しても削除されない．

## HTMLだけでは起動できない理由

通常のWebブラウザは，閲覧したHTMLから任意のCMD，EXE，PowerShell，Pythonを実行することを禁止している．この制約を回避するHTA，ActiveX，VBScriptなどは，安全性と互換性のため採用しない．

`START_HERE.html` と `site/index.html` は，起動方法を分かりやすく示し，起動済みの `http://127.0.0.1:8000/` を開くための静的案内ページである．実際の初回起動は `START_PAPER_TOOLS.cmd` が担当する．

## GitHub Pagesで公開できる範囲

`site/` はHTMLとCSSだけで構成し，相対パスで完結させている．将来GitHub Pagesへ公開する場合はこのディレクトリだけを配信対象にする．公開ページは次だけを担当する．

- アプリの説明と安全上の注意
- Windows版など配布物への導線
- ローカル起動手順
- 起動済みローカルアプリへのリンク

FastAPI，SQLite，Typst CLI，Ollama，アップロード，原稿編集はローカルアプリ側に残す．GitHub Pagesは静的ファイル配信だけであり，PythonサーバーやSQLiteを実行できない．既存画面全体をPages上で動かすには，IndexedDB，Typst WebAssembly，ブラウザ用生成処理への別実装が必要になる．

## 将来の配布案

次の段階ではPyInstallerのone-folder形式でWindows版を作り，GitHub Releasesへ配置する方法が現実的である．静的Pagesはダウンロード案内を担当し，インストール後のローカルアプリが研究データを扱う．one-file形式よりもJinja2，Typstテンプレート，静的資産を確認しやすく，起動速度とウイルス対策ソフトの誤検知にも有利である．
