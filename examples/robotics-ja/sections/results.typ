= 結果

合成した8試行の停止誤差は `data/trials.csv` に保存した．絶対誤差の平均は約6.1 mmであり，最大絶対誤差は9.1 mmであった．これらはpaper_toolsのtable表示とadviceを確認するための値であり，科学的な主張には使用できない．

#table(
  columns: 4,
  inset: 5pt,
  align: center,
  [*試行*], [*停止誤差 / mm*], [*許容範囲内*], [*備考*],
  [1], [5.2], [yes], [synthetic],
  [2], [-7.1], [yes], [synthetic],
  [3], [4.8], [yes], [synthetic],
  [4], [9.1], [yes], [synthetic],
  [5], [-6.4], [yes], [synthetic],
  [6], [3.9], [yes], [synthetic],
  [7], [-8.3], [yes], [synthetic],
  [8], [4.0], [yes], [synthetic],
)

\[DATA NEEDED: 標準偏差，信頼区間，実測値の校正方法\]
