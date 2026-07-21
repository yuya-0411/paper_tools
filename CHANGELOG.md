# 変更履歴

利用者に影響する変更を記録する．版番号はSemantic Versioningに従う．

## [0.1.0] - 2026-07-21

### 追加

- FastAPI，Jinja2，HTMX，Alpine.js，独自CSSによるローカルWebアプリケーション．
- SQLiteとSQLAlchemy 2系によるプロジェクト，著者，セクション，助言，生成履歴，参考文献の保存．
- 日本語・英語と8種類の独自Typstテンプレート．
- 決定論的なルールベース生成，Ollama，OpenAI互換，テスト用mockの共通provider境界．
- 入力正規化，PaperSpec，事前診断，構成，セクション，Typst，コンパイル，生成後診断から成るpipeline．
- 不足情報，図，表，データ，実験，比較，評価指標，再現性，統計，引用，構成，主張の助言．
- Typst CLIの安全な検出・実行とPDFプレビュー．Typst未導入時の明示的な縮退動作．
- ファイルアップロード，Hayagriva互換参考文献，BibTeX入出力，ZIPエクスポート．
- セクション単位の編集・再生成，自動保存，generation snapshot，復元．
- `serve`，`doctor`，`init-db`，`templates`，`compile`，`export` CLI．
- Windows向けダブルクリック起動，`launch` CLI，起動済み判定，ブラウザ自動表示．
- 将来のGitHub Pages公開に分離利用できる静的スタートページ．
- 日本語ロボティクスと英語工学論文の合成サンプル．
- pytest，Ruff，mypy，coverage，package buildを実行するLinux／Windows CI．

### セキュリティ

- project root境界，安全な内部file名，拡張子・size検査，Zip Slip防止．
- shellを介さないTypst実行，有限timeout，同一projectの同時compile制御．
- API keyのenvironment variable読込みと秘密情報の非表示．
- loopback bind，CSRF対策，HTML escape，外部CDN不要のlocal-first設計．

### 既知の制約

- 同梱templateは独自の汎用様式であり，特定学会の公式様式ではない．
- rule-based modeは意味的な翻訳や高度な校正を行わない．
- process内job管理は単一server向けであり，distributed queueではない．
- PDF生成にはlocalのTypst CLIと必要fontが必要である．
