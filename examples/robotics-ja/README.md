# 日本語ロボティクス論文サンプル

小型移動ロボットの架空研究を題材にした，`robotics-experiment` template向けの完全なoriginal sampleである．第三者の論文本文やofficial templateを複製していない．数値はすべてsoftware demonstration用に作成した合成dataであり，実在する装置・実験・研究成果を示さない．

## 含まれる内容

- `project.yml`：研究memo，実験条件，利用可能resource，詳細指示
- `main.typ` と `sections/`：日本語Typst原稿
- `figures/system-overview.svg`：original system構成図
- `data/trials.csv`：8回分のsynthetic trial data
- `references.yml`：未登録状態を明示する空のreference file

Advice engineの確認用に，従来手法との比較，標準偏差，実験環境写真，実在referenceを意図的に不足させている．不足内容を推測して補完してはならない．

Applicationへsampleを登録した後は，画面からsection編集とadviceを確認する．Typst CLIだけでsourceを確認する場合は次を実行する．

```bash
typst compile main.typ output/paper.pdf
```
