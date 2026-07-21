#set page(paper: "a4", margin: 16mm, columns: 2)
#set columns(gutter: 8mm)
#set text(size: 9pt, lang: "en")
#set par(justify: true, leading: 0.68em)
#set heading(numbering: "1.")

#align(center)[
  #text(size: 15pt, weight: "bold")[A Bounded-Gain Controller for a Synthetic Thermal Actuator Benchmark]
  #v(0.6em)
  Demo Author
  #linebreak()
  #text(size: 8.5pt)[paper_tools Synthetic Systems Laboratory]
]

#v(0.8em)
#block(inset: 7pt, fill: luma(245))[
  *Demonstration notice.* All measurements in this manuscript are synthetic data created for software evaluation. They do not describe a physical experiment.
]

#include "sections/abstract.typ"
#include "sections/introduction.typ"
#include "sections/method.typ"
#include "sections/experiments.typ"
#include "sections/results.typ"
#include "sections/discussion.typ"
#include "sections/conclusion.typ"

= References

The manuscript source is produced with Typst; its syntax is documented by the project maintainers @typst-docs.

#bibliography("references.yml", style: "ieee")
