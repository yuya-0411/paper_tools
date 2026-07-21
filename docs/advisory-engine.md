# Advisory engine

## 1．目的

Advisory engineは原稿の正しさを判定するのではなく，入力と原稿から不足候補を再現可能なruleで示す．Providerとは独立しており，LLMなしで必須診断を実行する．Adviceはstable ID，category，severity，title，description，reason，target section，suggested action，origin，resolvedを持つ．

## 2．Categoryとseverity

Categoryは `information`，`data`，`figure`，`table`，`experiment`，`comparison`，`metric`，`citation`，`structure`，`reproducibility`，`statistics`，`claim`，`limitation`，`preflight` を扱う．Severityは次である．

- `required`：生成継続はできるが，投稿前に必ず確認すべき不足
- `recommended`：品質，再現性，可読性を高める推奨
- `optional`：研究内容と投稿先に応じて判断する候補

## 3．必須rule一覧

| Condition | Advice |
|---|---|
| 研究目的が空または極端に曖昧 | 何を明らかにするか1～2文で明示する |
| 提案手法があるが従来との差がない | 新規性を明示する |
| 結果があるが実験条件がない | 環境，機器，設定，試行回数を追加する |
| 改善・高性能・有効という主張に数値がない | 定量値，指標，比較条件を追加する |
| 提案手法の評価にbaselineがない | 従来手法，既存設定，ablationと比較する |
| 結果があるが試行回数がない | trial，mean，variation，success rateを追加する |
| 複数試行があるが分散情報がない | standard deviation，CI，rangeを検討する |
| 複数module／sensorがあるがsystem figureがない | system構成図を追加する |
| controller／feedbackの記述があるが図がない | control block diagramを追加する |
| experimentがあるがenvironment figureがない | 配置，座標，寸法が分かる図を追加する |
| 時系列・trajectory・error等の記述にgraphがない | 対応するresult graphを追加する |
| 複数methodやconditionを比較するがtableがない | quantitative comparison tableを追加する |
| metricがない | taskに適したmetricを定義する |
| reproduction情報が不足 | hardware，software，version，parameter，seedを追加する |
| citation keyが未登録または主張にcitationがない | 実在referenceを利用者が登録する |
| result以上のclaimがある | claimをevidenceの範囲へ弱める |
| limitationがない | 適用範囲，failure condition，limitationを明示する |
| Placeholderが残る | 投稿前に解決または理由を確認する |

Ruleは単純なkeywordだけで断定せず，PaperSpec field，section role，asset metadata，reference key，数値patternを組み合わせる．誤検出を避けるため，断言ではなく理由と検出根拠を示す．

## 4．Template固有rule

Template manifestはrecommended figure／table／dataとsection roleを宣言できる．`robotics-experiment` ではsystem overview，robot appearance，control diagram，experiment setup，result graph，quantitative tableを候補とする．`literature-review` ではsearch strategy，classification，comparison table，research gapを優先する．共通ruleを複製せず，template tagに追加rule setを登録する．

## 5．Rule adviceとLLM advice

Rule adviceは同じ入力で同じ結果を返し，unit test可能で，外部送信を行わない．LLM adviceは文脈を広く扱えるが，非決定的で誤り得る．画面はoriginを明示し，LLM adviceをrequiredへ自動昇格させない．LLMが示したreferenceや数値はverified factとして取り込まず，`VERIFY` として扱う．

## 6．解決と誤検出

利用者はadviceを解決済みにできる．Resolveはrule自体を無効化せず，対象のinput hashとrule IDへ紐付ける．関連入力が変わりconditionが再成立した場合は再表示できる．誤検出の理由は任意memoとして残し，生成やexportを強制停止しない．ただしrequired項目とplaceholderはpreflight summaryへ残す．

## 7．Rule追加手順

1. Stable ID，category，severity，condition，message，evidenceを定義する
2. Typed contextだけを参照し，DBやnetworkへ直接accessしない
3. Positive，negative，language，template，edge case testを追加する
4. Registryへ登録し，本書とtemplate manifestを更新する
5. 誤検出率が高いruleはseverityを下げるか複数signalを要求する
