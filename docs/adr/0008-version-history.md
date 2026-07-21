# ADR 0008：Immutable snapshotでversion historyを残す

- Status：Accepted
- Date：2026-07-21

## Context

Generation，section再生成，Typst直接編集は大きな変更を起こすため，利用者が以前の状態へ戻せる必要がある．Full Git integrationはlocal userに余分なtoolと概念を要求する．

## Decision

全体生成前後，section再生成前後，Typst直接編集前，明示保存時にimmutable snapshotを作る．Snapshotはtarget，operation，provider，instruction，content hash，timestampを持つ．Restore自体もrestore前snapshotを作り，historyを破壊しない．同一content hashのautosaveは重複snapshotを作らない．

## Consequences

- UIから安全にundo／restoreできる
- Historyはapplication semanticsを持ち，providerやinstructionを表示できる
- Storageが増えるためbackup limitとpruning policyが必要である
- Fine-grained diffはtext diffで提供し，binary asset versioningは初期版で限定的である

## Alternatives

Gitは強力だが，installation，repository state，conflict handlingが初期利用者に重い．Mutable single backupは複数operationを追跡できないため採用しない．
