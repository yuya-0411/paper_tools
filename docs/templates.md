# Template management

## 1．Directory構造

Templateは `src/paper_tools/templates/<template-id>/` に置く．CodeへTypst sourceを埋め込まない．

```text
generic-ja/
├─ manifest.yml
├─ main.typ.j2
└─ sections/
   └─ section.typ.j2
```

同梱templateは独自の汎用様式であり，第三者の公式templateを複製しない．Previewもoriginal assetだけを使う．

## 2．Manifest仕様

```yaml
id: generic-ja
name: 日本語標準論文
description: 汎用的な日本語研究論文
languages: [ja]
document_types: [research-paper]
sections:
  - id: introduction
    title: はじめに
    required: true
required_inputs: [title, objective]
optional_inputs: [target_venue]
recommended_figures: []
recommended_tables: []
recommended_data: []
page:
  paper: a4
  margin: 22mm
columns: 1
fonts:
  body: auto
version: 1.0.0
```

IDはlowercase ASCIIとhyphenで安定させる．Section IDもfile名へ安全に使用できる値とする．Loaderはunknown key，duplicate ID，unsupported language，unsafe path，空section，不正versionを報告する．初期版の一覧previewはmanifestから生成する軽量なCSS模式図であり，画像assetは必須にしない．

## 3．標準template

- `generic-ja`
- `generic-en`
- `engineering-two-column`
- `robotics-experiment`
- `short-paper`
- `literature-review`
- `research-proposal`
- `experiment-report`

`engineering-two-column` は特定学会を名乗らない独自の2段組である．Language両対応templateは表示titleやsection titleをlocale dataから選ぶ．

## 4．新規template追加

1. Unique IDのdirectoryを作る
2. `manifest.yml` とすべてのrequired fieldを定義する
3. `main.typ.j2` と必要なpartialをoriginal codeで作る
4. User textをescapeするfilterを通し，unsafeなJinja expressionを許可しない
5. Relative pathだけを使い，OS固有separatorやabsolute pathを含めない
6. Original previewを追加する
7. Loader，snapshot，ja／en render，Typst integration testを追加する
8. Template一覧とREADMEを更新する

将来のZIP importは，展開前にentry count，total size，absolute path，`..`，symlink，duplicate，manifestを検証し，隔離directoryでvalidation後にだけ登録する．

## 5．Typst template作成

Style function，metadata，bodyを分離する．Sectionは `#include "sections/introduction.typ"` のようにproject内pathで参照する．WindowsでもTypst sourceでは `/` を使う．User textはstructured document modelからrenderer filterを通して挿入し，raw Typst fieldは明示されたsource editorだけに限定する．

Figureとtableにはlabel，caption，source metadataを付ける．ReferenceはHayagriva互換の`references.yml`からbibliographyを生成する．Fontは特定商用fontを必須にせず，環境で利用可能なfallbackを持たせる．

## 6．Template version

Manifest versionはtemplate contentの互換性を示す．初期版のprojectはtemplate IDを保存するが，template sourceのsnapshotとversion固定はまだ行わないため，同じIDの同梱templateを変更すると再render結果へ影響する．Templateを変更する際は互換性を保ってversionを上げ，snapshot／migration機構を追加するまで破壊的変更を避ける．判断は [adr/0006-template-management.md](adr/0006-template-management.md) を参照する．
