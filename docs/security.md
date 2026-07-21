# Security

## 1．Trust boundary

初期版は単一利用者のlocal-first applicationであり，既定で `127.0.0.1` だけにbindする．ただしbrowser入力，upload，database record，Typst source，provider response，subprocess outputは信頼しない．LAN／internet公開向けのauthentication systemではない．Template ZIP importは初期版では未実装である．

## 2．Upload

- 設定可能なbyte上限をstream中に適用し，全体を無制限にmemoryへ読まない
- PNG，JPEG，SVG，PDF，CSV，JSON，TXT，YAMLだけを許可する
- Original extension，signature，parse可能性を組み合わせ，MIME headerだけを信用しない
- Original nameは表示metadataに限定し，randomな内部名を使う
- Original filenameからbasenameだけを表示用metadataとして取り出し，control characterは置換する．保存pathにはrandomな内部名だけを使う
- SVGはactive contentを含み得るため，inline HTMLとして表示せず，安全なdownload／image policyを使う
- Fileを実行せず，project root内へatomic writeする

## 3．PathとZIP

すべてのpathはconfigured project rootから組み立て，`resolve` 後にもroot内であることを確認する．`..`，absolute path，drive／UNC prefix，symlink escapeを拒否する．DownloadはDBに登録されたsafe relative pathだけを対象にする．

初期版はZIPを展開しない．ExportではDBに登録されたmemberだけを固定名で書き込み，absolute path，`..`，duplicate，symlink escapeを拒否する．DB，`.env`，secret，project外fileは含めない．将来ZIP importを追加する場合は，entry count，individual／total size，compression ratioを含む事前検証を必須とする．

## 4．Typst compile

- Executableはsettingで明示したlocal binaryだけを使用する
- `shell=True` を使わずargument arrayを渡す
- Working directoryとrootを対象projectに限定する
- Source・output pathをserver側で解決し，userが任意flagを追加できないようにする
- Timeout，同一process内の同時実行上限を設け，保存するstdout／stderrは200 kBへ切り詰める
- Temporary outputへcompileし，成功確認後にPDFをatomic replaceする
- Errorをsanitizeし，absolute pathやsecretをbrowserへ不用意に表示しない
- Typst packageやfontのnetwork取得をapplicationから自動実行しない

Typst source直接編集は強力な機能である．Local利用者が自身のprojectを編集する範囲に限定し，remote multi-user利用へ転用する場合はsandboxを追加する．

## 5．API keyとsetting

API keyはenvironment variableから読み，DBへ平文保存しない．Screenは設定済みかどうかだけを示し，valueを再表示しない．Exception，structured log，provider error，generation history，ZIPへkeyやAuthorization headerを含めない．`.env` は`.gitignore`対象であり，`.env.example`にはdummyまたは空値だけを置く．

## 6．External transmission

Rule-based modeは外部通信しない．Ollama／OpenAI互換を選択した場合，送信先，provider，対象content，fallbackを実行前に示す．明示設定されていないproviderへ自動送信しない．Backendはuser inputから任意URLへfetchせず，HTTP(S)のconfigured provider endpointだけを使う．Credentialの転送を防ぐためprovider responseのredirectは拒否し，URLのuserinfo・query・fragmentも設定時に拒否する．

## 7．Web

- State-changing requestはCSRF tokenとsame-origin policyを検査する
- Jinja2 autoescapeを有効にし，user HTMLをsafe指定しない
- Cookieを使う場合はSameSite，HttpOnly，Secure条件を設定する
- Content Security Policyを設定し，外部CDNを必須にしない
- Productionではdebug tracebackを返さず，correlation IDとsanitized messageを示す
- Delete，restore，external generationは対象と結果を明示確認する
- Hostは既定loopbackであり，非loopback利用時には警告する．`0.0.0.0` は任意Host headerを許可せず，LAN利用時は具体的なbind addressを指定する

## 8．Local公開範囲

`paper-tools serve` のdefaultは `127.0.0.1:8000` である．これは同じPCのprocessからはaccess可能であり，強いsecurity boundaryではない．共用machineではOS accountとfile permissionを分離する．研究室serverで公開する場合はauthentication，TLS，reverse proxy，request limit，audit log，backup，upgrade procedureを追加する．

### 8.1．初期版の残る境界

- Uploadは1ファイルごとの上限，拡張子，主要binary signature，text parseを検査するが，HTTP request全体の総量制限はreverse proxyなしでは厳密でない
- Typst subprocessの出力はDB保存前に切り詰めるが，process実行中のcapture自体は一時的にmemoryを使用する
- 複数の原稿fileは各file単位でatomic replaceするが，DB transactionとdirectory全体を単一atomic operationにはできない
- Authenticationを持たないため，共用LANへそのまま公開しない

## 9．Incident時

Sensitive contentの外部送信が疑われる場合はserverを停止し，provider credentialをrotateし，access logとgeneration runを確認する．原稿をlogへ追加保存して調査しない．Databaseとproject directoryは一組でbackupし，restore testを定期的に行う．
