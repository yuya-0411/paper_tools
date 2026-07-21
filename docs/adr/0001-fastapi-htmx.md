# ADR 0001：FastAPI，Jinja2，HTMXを採用する

- Status：Accepted
- Date：2026-07-21

## Context

論文入力，section編集，advice，job進捗，PDF previewをbrowserで提供する必要がある．初期版はlocal-firstであり，大型SPAとfrontend build chainを避け，Python serviceと一貫したvalidation・testを保ちたい．

## Decision

FastAPIをHTTP層，Jinja2をserver-rendered HTML，HTMXをpartial更新，Alpine.jsを小さなclient stateへ使用する．Static assetはpackageへ同梱し，external CDNを必須にしない．Business logicはservice層へ置き，HTML routeとJSON／CLIから再利用する．

## Consequences

- Python中心で開発・testでき，JavaScript bundleが不要になる
- Progressive enhancementと通常formによりfailure時の挙動が明瞭になる
- Highly interactiveなrich editorには限界があるが，initial scopeのtextarea編集には十分である
- HTMX partialのresponse contractとCSRFをintegration testする必要がある

## Alternatives

React／Vue等はinteraction flexibilityが高いが，build tool，state管理，API duplicationが初期scopeに対して重い．Pure server-renderingは単純だが，autosaveとjob pollingで不要なfull reloadが増えるため採用しない．
