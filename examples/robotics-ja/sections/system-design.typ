= ロボットとシステム構成

対象は左右独立駆動の架空小型台車である．前方に左右二つの反射sensorを配置し，controllerが平均反射強度を計算する．Controllerは速度指令をmotor driverへ送り，local loggerが時刻，sensor値，速度指令を記録する．

#figure(
  image("../figures/system-overview.svg", width: 82%),
  caption: [小型移動ロボットのシステム構成．paper_tools sample用のoriginal SVGである．],
) <fig-system>

@fig-system に信号の流れを示す．図中の構成は実在装置の仕様ではない．
