# ADR 0003：SQLiteをmetadata storeに採用する

- Status：Accepted
- Date：2026-07-21

## Context

Project，author，section，version，advice，job，referenceをtransaction付きで保存し，accountやexternal databaseなしで個人PCへ導入したい．

## Decision

SQLiteとSQLAlchemy 2系を使用し，Alembicでschema migrationを管理する．MetadataはDB，Typst／asset／PDFはproject directoryに保存し，DBへsafe relative pathとhashを持つ．Foreign keyを有効にし，write transactionを短く保つ．

## Consequences

- Single fileでbackup・初期化でき，Python環境だけで利用できる
- Relational constraintとmigrationが使える
- Large binaryをDB外に置くためexport layoutが分かりやすい
- High-concurrency multi-server writeには向かず，将来その要件が生じた場合はrepository境界の後ろでDBを差し替える

## Alternatives

YAML／JSONだけではtransaction，relation，query，concurrent autosaveが弱い．PostgreSQLは強力だがlocal installationを複雑にするため初期版では採用しない．
