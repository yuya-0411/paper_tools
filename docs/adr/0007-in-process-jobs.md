# ADR 0007：初期版は軽量なprocess内job管理を使う

- Status：Accepted
- Date：2026-07-21

## Context

GenerationとTypst compileはrequestより長くなる場合があり，progress，timeout，cancel，duplicate prevention，reload後の確認が必要である．一方でRedisやdistributed workerを導入するとlocal installationが複雑になる．

## Decision

FastAPI process内のasync job managerとproject単位lockを使い，永続的なrun状態をSQLiteへ記録する．UIはHTMX pollingでstatusを取得する．Application startup時に残ったrunning stateをfailedへ回復する．Jobは有限timeoutとcooperative cancellationを持つ．

## Consequences

- Additional serviceなしでlocal利用できる
- Browser reload後もDBから状態を確認できる
- Process crash時にjobは継続せず，recovery reasonを表示する
- Multiple web processや複数machineには対応せず，将来は同じJobManager interfaceの後ろでexternal queueへ差し替える

## Alternatives

Celery／RQ等はdistributed operationに適するが，初期scopeには重い．Request内同期実行はtimeoutとUI clarityが悪いため採用しない．WebSocketは不要であり，simple pollingを優先する．
