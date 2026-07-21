= Method

Let $e_k = T^star - T_k$ denote the temperature error at sample $k$. The command is

$ u_k = clamp(K e_k, 0, u_max), $

where the synthetic benchmark uses $K = 0.18$ and $u_max = 1$. The simulated plant applies a fixed first-order update. No process noise, sensor bias, or actuator delay is included.

#figure(
  image("../figures/test-rig.svg", width: 100%),
  caption: [Synthetic controller and plant used by the demonstration. The diagram is an original paper_tools asset.],
) <fig-rig>

@fig-rig shows the information flow. The logger writes only the generated benchmark values in `data/summary.csv`.
