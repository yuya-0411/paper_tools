# ADR 0002：Typstを正式な原稿形式とする

- Status：Accepted
- Date：2026-07-21

## Context

Form入力から生成した原稿を人が読んで編集でき，styleとcontentを分離し，localでPDFへ変換する必要がある．LaTeXの完全なmacro処理をapplication側へ持ち込まず，軽量なauthoring flowを目指す．

## Decision

Primary sourceをTypstとし，`main.typ`，分割section，Hayagriva互換`references.yml`，relative asset pathを生成する．PDFはlocal Typst CLIをargument array，timeout，project root制限で起動して作る．Typst未導入時はsource生成とeditingを維持し，PDFだけをunavailableとする．

## Consequences

- Sourceが比較的簡潔で，templateとsection分割を保ちやすい
- Compile速度がpreview用途に適する
- 利用者は必要に応じてTypst CLIとfontを導入する必要がある
- 学会がLaTeX／Wordだけを要求する場合の最終変換は初期scope外である

## Alternatives

LaTeXはecosystemが大きいが，初期systemのprimary format要件と安全なgeneration simplicityに合わない．HTML-to-PDFはpaper semanticsとcitationが弱く，Wordはserver-side generationとversionable sourceに不向きなため採用しない．
