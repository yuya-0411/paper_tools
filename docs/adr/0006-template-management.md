# ADR 0006：Manifest付きresourceとしてtemplateを管理する

- Status：Accepted
- Date：2026-07-21

## Context

複数language・document typeのTypst templateを選択し，将来利用者templateを追加したい．Third-party official templateを無断複製せず，code変更なしでmetadataとsectionを発見できる必要がある．

## Decision

`src/paper_tools/templates/<id>/` に `manifest.yml`，Jinja2／Typst source，partial，previewを置く．Loaderはmanifest schema，safe path，unique ID，versionを検証する．Projectは選択時のtemplate IDとversionを保存し，既存sourceを新版で暗黙に上書きしない．

## Consequences

- Templateの追加と一覧表示がdata-drivenになる
- Package dataとsource distributionへresourceを明示収録する必要がある
- Jinja2とTypstの二層escape，snapshot test，version migrationが必要になる
- Future ZIP importはZip Slip，size，symlink，manifest validationを必須とする

## Alternatives

Python stringへの埋込みは簡単だが，preview・metadata・version・user extensionに不向きである．External template downloadはoffline要件とsupply-chain riskに反するため初期版では採用しない．
