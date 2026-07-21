# Generation pipeline

## 1．PaperSpec

`PaperSpec` は画面固有のfieldやDB rowから独立した，生成処理の正規化入力である．Project metadata，language，paper type，template，authors，known facts，research fields，assets，references，global instructions，section instructions，style optionを保持する．空白，改行，author order，keyword，section IDを正規化し，利用者が入力した事実と生成済みtextを混同しない．

## 2．Pipeline

1. Form／DB入力を検証して正規化する
2. `PaperSpec` を作る
3. Required fieldと整合性を事前診断する
4. Template manifestからsection構成を作る
5. Sectionごとのgeneration requestを作る
6. Providerで本文を生成する
7. Typed Typst document modelへ変換する
8. Templateをrenderし，分割sourceを保存する
9. Typstが利用可能ならcompileする
10. 生成原稿，asset，referenceを再診断する
11. Versionとgeneration runを確定する

大きな単一promptや関数へ統合せず，段階ごとのinput／outputをtestできるようにする．

## 3．構成生成

Template manifestのsectionを基本とし，paper type，研究内容，page目安，利用者指示から必要なsectionを選ぶ．Rule-based modeではsectionを勝手に削除せず，情報がないsectionにplaceholderを置く．構成だけを再生成する操作は既存本文と独自sectionを保持し，templateの見出しと順序を再適用してsource snapshotとgeneration runを残す．

## 4．Section生成

各requestにはsection ID，heading，目的，known facts，bullet notes，使用可能なasset／reference，global instruction，section instruction，language，style，missing fieldsを含める．Provider responseはplain proseとplaceholderを基本とし，unsafeなraw Typstはrendererへ直接通さない．Section単位の失敗は他sectionを破壊せず，errorとfallback結果をrunへ記録する．

## 5．Prompt組立

LLM向けpromptは次の順序を固定する．

1. 「入力にない事実，結果，数値，文献，著者を作らない」という安全制約
2. Output languageとacademic style
3. Templateとsectionの役割
4. Verified factsとreference key
5. User instructions
6. Missing fieldsとplaceholder format
7. Machine-readable response schema

User inputをsystem instructionとして扱わず，instruction injectionにより安全制約が上書きされないよう区分する．Responseはlengthとschemaを検証し，reference keyは登録済みsetと照合する．

## 6．日本語・英語

日本語は「である調」，句読点 `，．` を既定とする．設定により `、。` を選べる．英語は簡潔で客観的なAcademic Englishとし，American／British spellingを選ぶ．過剰な強調，不要な一人称，evidenceのない断定を避ける．Translationとsemantic rewriteはLLM providerが利用可能な場合だけ提供し，利用不可はconfiguration guidanceとして返す．原稿全体の翻訳では，タイトル，キーワード，全sectionを境界付きJSONで渡し，応答が全sectionを一度ずつ含むことを検証する．元原稿と応答の数値token，引用key，標準placeholderの個数が一致しない場合は反映しない．翻訳前のsection IDと順序は保持し，現在のtemplateが対象言語を扱えない場合だけ汎用templateへ切り替える．

## 7．Rule-based generation

Rule-based providerは決定論的で，networkを使わない．Known factsをsection別に分類し，入力文を保存しながらheadingと接続文を作る．必須要素が空の場合はplaceholderを追加する．例えば結果はあるがtrial countがない場合，結果値を発明せず `[DATA NEEDED: 試行回数，平均値，ばらつきを記載してください]` とする．同じ入力とtemplate versionから同じ出力を得る．

## 8．LLM利用時

OllamaとOpenAI互換providerは共通requestを受ける．Call前に外部送信範囲をUIへ示す．Timeout，HTTP error，invalid schema，empty responseではerror detailからsecretを除去し，fallback許可時はrule-based結果を返す．Provider名，model，instruction，fallback，durationをgeneration runへ保存するが，API keyは保存しない．

## 9．Placeholder

Standard marker：

```text
[TODO: 実験条件を記載]
[DATA NEEDED: 成功率の測定結果]
[FIGURE NEEDED: システム構成図]
[CITATION NEEDED: 関連研究]
[VERIFY: 数値と単位を確認]
```

Markerは全文検索しやすいASCII labelとし，説明だけをproject languageに合わせる．Rendererはmarkerを削除しない．Advice engineはmarkerを対応categoryへ関連付け，利用者が内容を確認して解決するまで残す．
