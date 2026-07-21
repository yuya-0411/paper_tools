# Development plan

## 1．方針

最初のreleaseは，localで日本語・英語の論文を作成し，rule-basedでTypst sourceとadviceを得て，TypstがあればPDFとZIPを出力できる縦断的な機能を優先する．Optional LLMはcore機能から分離し，第三者template，cloud hosting，大型frontendを導入しない．

## 2．実装段階

### Phase 1：Foundation

- 仕様，architecture，ADR，package metadata，設定，exception
- FastAPI app factory，CLI，SQLite，Alembic
- Health／doctor，local data directory

Exit criteriaはinstall，`paper-tools --help`，`doctor`，`init-db`，home表示である．

### Phase 2：Domainとtemplate

- Project，Author，PaperSpec，Section，Version，Asset，Reference，Run，Advice model
- Repositoryとtransaction
- 8 templateのmanifest，loader，validation，preview
- 日本語／英語document model

Exit criteriaはtemplate一覧とproject wizardの保存である．

### Phase 3：Generationとadvice

- Input normalization，planning，rule-based generation
- Placeholder policy，Typst rendering
- Mandatory advisory rule registry
- Mock，Ollama，OpenAI-compatible providerとfallback

Exit criteriaは簡易入力からsection，Typst，adviceを一貫して生成できることである．

### Phase 4：Editingとartifact

- Section edit／regenerate，autosave，history，restore
- Safe upload，reference管理
- Typst compile，PDF preview，source download
- ZIP export

Exit criteriaはprojectを再度開き，履歴から復元し，artifactを取得できることである．

### Phase 5：Hardening

- Job state，duplicate prevention，timeout，restart recovery
- CSRF，escape，path／ZIP boundary，secret masking
- Responsive／keyboard UIと具体的error
- Unit，integration，web，Typst optional test
- Ruff，mypy，coverage，package build，Linux／Windows CI

Exit criteriaはREADMEの手順が再現可能で，quality gateとpackage buildが成功することである．

## 3．Decision default

- Python 3.11をminimumとする
- Hostは `127.0.0.1`，portは `8000`
- Providerはrule-based，external fallbackは有効
- Databaseとprojectはuser application data directoryへ置く
- Upload上限は20 MiBを初期値とし，設定可能にする
- Typst timeoutは60秒，project単位でcompileをserializeする
- 日本語は `，．` と「である調」，英語はAmerican Englishをdefaultとする
- Project deleteは確認後に実行し，version snapshotは設定した上限まで保持する
- Jobは初期版でin-processとし，分散queueは対象外とする

これらはlocal-first，低依存，安全な縮退，test容易性を優先した合理的defaultである．変更理由は対応ADRに記録する．

## 4．Quality gate

```bash
ruff check .
ruff format --check .
mypy src
pytest --cov=paper_tools --cov-report=term-missing
python -m build
paper-tools --help
paper-tools doctor
paper-tools init-db
paper-tools templates
```

Main logic coverageは80％以上を目安とする．External LLMをtestへ使わず，Typst integrationはCLIが存在する場合だけ実行する．Windows／Linux双方でpathとfile lockingを検証する．

## 5．Release後の優先候補

1. Asset metadataからのTypst tableとsimple graph候補
2. Figure／citation整合性，unused reference，terminology，punctuation，acronym rule
3. Completion dashboardとPDF thumbnail
4. Safe custom template ZIP import
5. Project duplicateとJSON import／export
6. Review response，abstract，title，keyword等の限定generation
7. Authenticationとexternal job queueを備えた研究室server profile

必須機能の回帰とsecurityを犠牲にして追加しない．
