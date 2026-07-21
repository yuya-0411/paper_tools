# paper_tools 0.2.0 仕様書

## 1．目的と対象ユーザー

`paper_tools` は，Typstの詳細を知らない研究者，学生，技術者が，研究メモと確認済みの事実から論文の構成と原稿を作成するためのローカルWebアプリケーションである．対象は個人PCまたは信頼できる研究室内serverであり，UIは日本語を基本とする．原稿は日本語と英語に対応する．

本システムは著者の判断を代替しない．研究の正当性，数値，引用，著者順，投稿規定への適合は利用者が最終確認する．

## 2．機能要件

### 2.1 Projectと入力

- 5段階のwizardで基本情報，複数著者，研究内容，図表・data，詳細指示を保存する
- 簡易入力だけでもPaperSpecと構成案を作成できる
- 詳細入力では背景，課題，目的，新規性，手法，system，実験条件，指標，結果，考察，制約，結論を扱う
- 論文全体とsection別の指示，複数presetを保存する
- 日本語／英語，句読点，英語variant，templateをproject単位で選択する
- 入力，section，指示，Typst sourceをdebounce付きで自動保存する

### 2.2 Generation

- 入力正規化，事前診断，構成，section，Typst document，生成後診断を分離する
- rule-based providerを既定とし，外部serviceなしで決定論的に生成する
- Ollama，OpenAI互換API，test用mockを共通interfaceで差し替える
- provider failure時は設定に従いrule-basedへfallbackする
- 未入力の事実，数値，結果，文献，著者を推測せずplaceholderにする
- section単位と全体の再生成前後にversionを保存する

### 2.3 TemplateとTypst

- 8種類の独自templateをresource directoryから読み込む
- manifestのID，言語，document type，sections，必須・任意入力，推奨resource，page設定，versionを検証する
- `main.typ`，`sections/`，`references.yml`，`figures/`，`data/` を生成する
- local Typst CLIを検出し，利用可能な場合だけPDFをcompileする
- compile timeout，stdout／stderr，exit code，error locationを記録する
- compile failure時に以前の正常PDFを保持する

### 2.4 Editingとhistory

- section本文と指示の編集，手動保存，自動保存，再生成，version復元を提供する
- Typst sourceの直接編集前にもsnapshotを作る
- historyへ日時，対象，操作，provider，指示を保存する
- 同一内容の過剰な自動保存を避け，保存中・保存済み・失敗を表示する

### 2.5 Advice

- 不足情報，data，figure，table，experiment，comparison，metric，reproducibility，statistics，citation，structure，claim，limitation，preflightを診断する
- `required`，`recommended`，`optional` のseverityを持つ
- template固有ruleを追加できる
- adviceは対象section，理由，推奨action，解決状態を持つ
- LLMなしで必須ruleを実行し，LLM adviceとは由来を区別する

### 2.6 Asset，reference，export

- PNG，JPEG，SVG，PDF，CSV，JSON，TXT，YAMLを設定上限までuploadする
- 安全な内部file名とproject内相対pathを使用する
- assetの表示名，説明，用途，section，出典，自作／引用を保存する
- Hayagriva互換YAMLを内部標準とし，BibTeX import／exportを扱う
- 重複key，未使用reference，存在しないcitationを表示する
- project source，asset，reference，利用可能なPDFをZIPへexportする

## 3．非機能要件

- 内部実装はPython 3.11以上，FastAPI，Jinja2，HTMX，Alpine.js，独自CSS，SQLite，SQLAlchemy 2系とし，Windows配布版には実行環境を同梱する
- React等の大型SPA，Electron，外部CDNを必須にしない
- internet，account，有料API，Dockerなしで基本機能を利用できる
- UIはkeyboard操作，label，focus，色以外の状態表示，responsive layoutを備える
- 長時間処理は状態，progress，error，timeout，cancelを記録し，同一projectの二重実行を防ぐ
- main logicのcoverage 80％以上を目安とし，LinuxとWindowsでtestする
- service，provider，repository，web routeを分離し，型検査可能にする

## 4．対象外

- 研究結果・referenceの自動発明，事実性の保証，査読または研究倫理審査の代替
- 特定学会の公式templateの同梱または完全な投稿規定検査
- 外部文献検索serviceによるreferenceの自動取得
- 初期版でのaccount，multi-tenant権限管理，internet公開，分散job queue
- 高機能WYSIWYG，Monaco／CodeMirror，大型SPA，native desktop packaging
- Typst未導入環境でのPDF生成

## 5．主要画面

| 画面 | 主な内容 |
|---|---|
| Home | 最近のproject，新規作成，template，Typst／provider状態 |
| Project一覧 | title，language，template，status，不足数，PDF，open／export／delete |
| 新規作成 | 5段階wizardと途中保存 |
| Editing | section，本文，指示，Typst，PDF，advice，history |
| Template一覧 | language・document type filter，preview，sections，選択 |
| Setting | Typst，provider，保存先，upload上限，句読点，英語variant，backup数 |
| Delete確認 | 対象と不可逆性を示す明示確認 |

## 6．入出力

入力はform field，textarea，upload file，Hayagriva YAML，BibTeX，environment settingである．出力はSQLite record，project directory，Typst source，PDF，advice，compile log，ZIPである．JSON APIはHTMX画面と同じservice層を使い，user inputをHTMLへ表示するときはescapeする．

Projectの実行時file layout（`project.yml` はZIP export時に生成し，historyはSQLiteに保持）：

```text
projects/<project-id>/
├─ main.typ
├─ sections/
├─ references.yml
├─ figures/
├─ data/
└─ output/paper.pdf
```

## 7．生成方針

確定入力と生成文章を区別し，providerへ渡すrequestへlanguage，template，section，instructions，known facts，missing fieldsを明示する．rule-based modeは入力を並べ替えて定型文とplaceholderを作り，意味的な事実を補完しない．LLM modeでも同じ制約をsystem instructionへ含め，responseをschema検証し，diagnosticを再実行する．

標準placeholderは `[TODO: ...]`，`[DATA NEEDED: ...]`，`[FIGURE NEEDED: ...]`，`[CITATION NEEDED: ...]`，`[VERIFY: ...]` である．日本語原稿ではlabel説明を日本語化する．

## 8．安全方針

- 実験結果，数値，文献，著者，未確認事実を捏造しない
- 結果がない場合は不足を明示し，citation keyがない主張はcitation候補が必要と示す
- 外部provider利用時は送信を画面で明示し，利用者の選択なしに送信しない
- API keyはenvironmentから読み，DB，log，page，exportへ含めない
- upload，path，ZIP，Typst subprocessの境界をserver側で検証する
- local利用でもCSRF，HTML escape，size limit，timeout，error sanitationを省略しない

詳細な脅威とcontrolは [security.md](security.md) に記録する．
