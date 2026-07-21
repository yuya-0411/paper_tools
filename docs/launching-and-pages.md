# 自己完結Windows版とGitHub Pagesの境界

## 利用者にPythonを要求しない構成

一般利用者向けの配布経路は次のとおりである．

```text
GitHub Pages
  └─ 製品説明とダウンロード
       └─ GitHub Releases
            ├─ paper-tools-setup-x64.exe
            ├─ paper-tools-windows-x64.zip
            └─ SHA256SUMS.txt
                  ↓
          Windowsローカルアプリ
            ├─ Pythonランタイム
            ├─ FastAPI/Jinja2/SQLite
            └─ Typst CLI
```

`paper-tools-setup-x64.exe` は利用者ごとの `%LOCALAPPDATA%\Programs\paper_tools` へインストールするため，管理者権限を要求しない．Python，pip，仮想環境，Typstのセットアップは不要である．ポータブル版はZIPを展開して `paper_tools.exe` を実行する．GitHubのSource ZIPはアプリ配布物ではない．

## デスクトップ起動のライフサイクル

PyInstallerのone-folder形式でPythonと依存関係を同梱する．one-file形式のように毎回大きな実行環境を一時展開しないため，起動時間，障害調査，ウイルス対策ソフトとの相性を優先できる．Inno Setupインストーラーがone-folder一式をまとめるため，利用者は内部構造を意識しない．

`paper_tools.exe` は次を自動実行する．

1. ユーザー固有ロックを取得し，二重起動を防ぐ．
2. `127.0.0.1` の設定ポートを確保し，競合時は空きポートへ切り替える．
3. FastAPIを同一プロセス内で起動し，`/healthz` の準備完了を待つ．
4. 既定ブラウザを開き，Windows通知領域へpaper_toolsアイコンを表示する．
5. 通知領域の「終了」でUvicornとSQLiteを正常終了する．

二度目の起動では，データディレクトリの実行情報とアプリ識別応答を確認し，既存画面だけを開く．ログは `%LOCALAPPDATA%\paper_tools\logs\paper_tools.log` へローテーション保存する．原稿，SQLite，PDFは `%LOCALAPPDATA%\paper_tools` 以下に置き，インストール更新から分離する．

## 同梱Typst

ビルド時に公式Typst Windows x64配布物を取得し，GitHubが公開するSHA-256と照合してから同梱する．現在の固定値はTypst 0.15.1，アーカイブSHA-256は `19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736` である．ライセンスと取得元情報も配布物へ含める．

明示的な `PAPER_TOOLS_TYPST_EXECUTABLE` 設定がなければ，同梱版をPATHより優先する．ソース開発時に同梱版がない場合だけ，従来どおりPATH上の `typst` を探索する．

Python本体，各Pythonパッケージ，Typst，ブラウザ内ライブラリのライセンス文書は，配布ディレクトリの `_internal/licenses/` と静的資産内のライセンス一覧へ収録する．

## CI，Artifact，Release

`.github/workflows/windows-release.yml` はWindows上で次を実行する．

- `uv.lock` に固定された開発・デスクトップ依存を同期
- 公式TypstのダウンロードとSHA-256検証
- PyInstaller one-folderビルド
- 凍結済みアプリのWeb資産，SQLite，同梱Typst，PDF生成セルフテスト
- Inno SetupインストーラーとポータブルZIPの生成
- `SHA256SUMS.txt` の生成
- Actions Artifactへの30日間保存
- `v<アプリ版>` タグの場合だけGitHub Releaseへ恒久公開

一般利用者は期限切れやログイン制約があるActions Artifactではなく，GitHub Releaseを使用する．リリースタグは `src/paper_tools/__init__.py` の版と一致しなければ公開処理を失敗させる．

## GitHub Pages

`site/` は静的HTMLとCSSだけであり，研究データ，APIキー，SQLiteを扱わない．主ボタンは最新GitHub Releaseの固定名インストーラーへ接続する．FastAPI，Typst，Ollama，ファイル操作はインストール後のローカルアプリが担当する．

`.github/workflows/pages.yml` は意図しない公開を避けるため手動実行だけにしてある．公開するときはリポジトリの Settings → Pages → Source を `GitHub Actions` に設定し，Actions画面から `GitHub Pages` ワークフローを実行する．自動更新が必要になった段階で，`main` の `site/**` 変更をpushトリガーへ追加する．

通常のHTMLからローカルEXEを勝手に起動する回避策は採用しない．Pagesは安全な配布入口，EXEは利用者が明示的にインストールして起動するローカルアプリ，という境界を維持する．

## ソース開発者向け互換起動

`START_PAPER_TOOLS.cmd` と `paper-tools launch` は開発者向けに残す．これらはPython環境からソースを実行するための手段であり，一般利用者向けの標準経路ではない．

## 署名について

現在のワークフローは再現可能なハッシュを生成するが，コード署名証明書は含まない．未署名インストーラーではWindows SmartScreenが警告する場合がある．公開運用では，PyInstallerビルド後の実行ファイルと最終インストーラーにAuthenticode署名とRFC 3161タイムスタンプを付ける．秘密鍵をリポジトリへ保存せず，OIDC対応の署名サービスまたは保護されたCIシークレットを利用する．
