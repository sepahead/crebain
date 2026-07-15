# 0.9 candidate disposition

`TASK_DISPOSITION.csv` accounts for every T000–T158 instruction in the supplied
CREBAIN 1.0 handoff. The handoff's own completion rule says a task remains open
unless every acceptance/evidence item passes or its claim is removed. It also
defines a strict dependency chain through external final contracts, hardware,
independent review, and cross-repository convergence that do not exist here.
Accordingly, every `ledger_1_0_status` is honestly `OPEN`.

The separate `release_0_9_disposition` records what was implemented, reviewed,
preregistered, narrowed, not run, or externally blocked for the requested 0.9
research-only prerelease. This is not a relabeling of partial work as 1.0.

The CSV is reproducibly extracted from the exact 1.0 ledger with
`scripts/generate-task-disposition.py`. The twenty-lens lead review and release
decision are in `TWENTY_LENS_REVIEW.md` and
`docs/NARROWED_GO_0.9.0.md` respectively.
