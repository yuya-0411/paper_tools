# Text generation providers

## 1．共通interface

```python
class TextGenerationProvider(Protocol):
    async def generate(
        self,
        request: GenerationRequest,
    ) -> GenerationResponse:
        ...
```

`GenerationRequest` はlanguage，section，verified facts，available references，instructions，missing fields，limitsを持つ．`GenerationResponse` はgenerated content，provider metadata，warning，fallback情報を持つ．Providerはroute，DB，template，filesystemへ直接accessしない．

## 2．Rule-based

既定providerであり，network・model・API keyを必要としない．Known factsとmemoをsectionへ分類し，template文とplaceholderを決定論的に組み立てる．高度な翻訳や意味的校正は行わないが，構成，本文draft，Typst，adviceまで利用できる．

選択範囲の意味的変換と原稿全体の翻訳はLLM専用である．この2操作ではrule-based fallbackを無効にし，失敗を履歴へ明示する．選択変換が元文章にない数値・引用を追加した場合，または確認用placeholderを削除した場合も応答を拒否する．

## 3．Ollama

Local Ollama APIへ有限timeoutで接続する．Base URLは既定でloopbackとし，modelを明示設定する．Health checkは短いrequestで状態を返し，Ollama未導入をapplication failureにしない．Connection error，timeout，invalid responseではrule-basedへfallbackできる．TestはHTTP transportをmockし，実Ollamaを起動しない．

## 4．OpenAI互換API

Genericなchat completion互換endpointを対象とし，特定企業のSDKへ密結合しない．設定はbase URL，API key，model，timeout，temperature，maximum output tokensである．API keyはenvironment variableからだけ読み，DB・screen・log・ZIPへ平文保存しない．Endpointはadministratorが明示したURLだけを使い，user inputから任意URLを作らない．

## 5．Mock

Test用providerは固定responseまたは投入したresponseを返し，call requestを検査できる．Network，clock，randomnessへ依存しない．Error，timeout，malformed response，fallbackも再現可能にする．Production settingでmockを誤選択した場合は明瞭に表示する．

## 6．Provider選択とfallback

Projectまたはapplication settingからproviderを選び，factoryが実装を生成する．利用前にconfigurationとavailabilityを検査する．外部provider failure時は，fallback有効なら同じPaperSpecをrule-basedへ渡し，結果へfallback warningを付ける．ProviderがないことをHTTP 500とせず，設定案内またはrule-basedへ戻す．

## 7．新規provider追加

1. Common Protocolを実装する
2. Provider固有settingをtyped modelへ追加する
3. Secret maskingとexternal-transfer noticeを定義する
4. Timeout，size limit，schema validation，error mappingを実装する
5. Factoryへ明示登録する
6. Success，failure，timeout，fallback，secret非表示testを追加する
7. 本書と`.env.example`を更新する

Routeやgeneration serviceにprovider名の大きなconditionalを追加せず，factory／registryで解決する．

## 8．Privacy

Rule-basedと通常編集は外部送信しない．Ollamaが別hostならそのnetworkへ，OpenAI互換providerなら設定先へ，生成requestに含まれる原稿内容が送信される．UIは実行前に送信先と範囲を明示する．機密，未公開，個人情報を含む原稿では，組織規程とprovider policyを確認する．Logにはprompt本文とsecretを既定で残さない．
