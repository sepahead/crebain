# Release audit records

`frozen/` binds the exhaustive base review to Git commit
`4c311900ade5668200a48d56fb191be1916b884a`. Its file ledger is generated from
Git blobs, not the mutable worktree, by `scripts/audit-tracked-files.py`.

`generated/` contains the frozen claim-language/token inventories and the three
exact review packets used for assignment. These are discovery inventories, not
proof that a claim is correct. The authoritative per-file review state is
`frozen/FILE_REVIEW_LEDGER.csv`; limitations and findings are in
`frozen/REVIEW_REPORT.md`.

The release candidate necessarily differs from the frozen base. Candidate
manifests must therefore be generated **after** the candidate commit/tag and
published as digest-bound release evidence. An in-tree file cannot honestly
embed its own final Git blob/commit identity. Release evidence must not relabel
the three same-team review lanes as independent review.
