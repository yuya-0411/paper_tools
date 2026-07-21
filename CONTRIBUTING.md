# コントリビューションガイド

## 開発環境

Python 3.11以上を使用する．

```bash
python -m venv .venv
source .venv/bin/activate  # Linux／macOS
python -m pip install -e ".[dev]"
pre-commit install
```

Windows PowerShellでは `.\.venv\Scripts\Activate.ps1` で有効化する．

## 設計原則

- 論文本文，参考文献，図，データを利用者の明示操作なしに外部へ送らない．
- 有料API，Ollama，Typstがなくても，該当機能以外は正常に利用できるようにする．
- HTTP routeとCLI handlerを薄くし，生成，保存，外部process，file操作をservice層へ置く．
- provider固有処理を共通interfaceの外へ漏らさない．
- 入力されていない実験結果，数値，文献，著者，事実を生成しない．
- templateは第三者様式を複製せず，manifest付きの独自resourceとして管理する．
- path操作は `pathlib.Path` を使い，解決後のproject root境界を検査する．
- 外部commandは引数配列，有限timeout，`shell=False` で実行する．
- 日本語user向け文書は原則として句読点 `，．` を使う．

## 品質確認

```bash
ruff check .
ruff format --check .
mypy src
pytest --cov=paper_tools --cov-report=term-missing
python -m build
paper-tools --help
paper-tools doctor
paper-tools init-db
paper-tools templates
```

Ruff・mypy・pytestの失敗を広いignore，無条件skip，warning抑止で隠さない．Typst統合testだけは，CLI未導入時に理由付きでskipできる．外部LLM，network，wall clock，利用者固有pathへ依存するtestを作らない．

## コードとテスト

- 公開APIとservice boundaryへ型annotationを付け，strict mypyを満たす．
- bug修正には修正前に失敗する最小regression testを加える．
- file system testは `tmp_path`，時刻は注入可能なclock，HTTP・subprocessはmockを使う．
- WindowsとLinuxのpath separator，改行，file locking差を考慮する．
- generation testではsynthetic inputを使い，実在の論文，著者，未許諾templateをfixtureへ含めない．
- Web変更ではkeyboard操作，label，focus，色以外の状態表示，CSRF，escapeを維持する．

## Template・provider・advice ruleの追加

Template追加は [docs/templates.md](docs/templates.md)，provider追加は [docs/providers.md](docs/providers.md)，advice rule追加は [docs/advisory-engine.md](docs/advisory-engine.md) に従う．識別子や保存schemaを変更する場合は，migration，test，README，CHANGELOG，関連ADRを同時に更新する．

## 変更の提出

- 一つの目的に集中し，無関係な整形を混ぜない．
- API key，token，`.env`，local原稿，個人情報，絶対pathをcommitしない．
- user-visible command，設定，画面，export形式を変更した場合は文書も更新する．
- 実行した検証commandと結果，環境上実行できなかった任意testを記録する．
- 既存remoteを変更せず，明示依頼なしに外部へpushしない．
