# CREBAIN 0.9.0 cross-repository boundary

This is an explicit requirements handoff, **not** the 1.0 local convergence
manifest. The supplied convergence schema requires all 159 local tasks,
independent evidence, a clean exact commit, ten completed waves, and
`ready_for_cross_repo_reconciliation: true`. Those conditions are false and no
conforming manifest is fabricated.

The master handoff froze these external audit cuts on 2026-07-14:

| Repository | Frozen audit head |
|---|---|
| NCP | `0ba5ff6e963225b0635f8fec349278f1ac287df3` |
| pid-rs | `64060035ea36e380004949f06dd226dcc7242b96` |
| Galadriel | `94e2f8cc01f352d2bf899b7f656997f143a2588f` |
| Haldir | `9cf56e149a105026b072c9073d7e87b93103966e` |

Other agents may advance those repositories independently. CREBAIN 0.9 does
not silently adopt such work and places no request to rewrite or retag their
0.9 candidates.

## Current exact dependency

CREBAIN's dormant opt-in NCP paths remain pinned to annotated tag `v0.8.0`:
the tag object is `54008b16ea0c195a4ccc9691cb533dd1153bf7f0` and its peeled Cargo commit is
`2f5bd586d4bb20c90362bb6f5698b7f64057ba4e`. The TypeScript lock records the
tag object abbreviation and Cargo.lock records the peeled commit. Default 0.9
packages omit the NCP feature. This is not an NCP 1.0 or ecosystem-convergence
claim.

## Future change requests

| ID | Producer | Requirement before CREBAIN may adopt it | CREBAIN consumer evidence required |
|---|---|---|---|
| CR-CREBAIN-001 | NCP | Publish an immutable final 1.0 semantic/wire identity, canonical vectors, mixed-version policy, stable crates/package, and security contract. | Pin exact tag object/commit and contract digest; run default-off, feature, canonical, malformed, downgrade, replay, lifecycle, and live authenticated topology campaigns. |
| CR-CREBAIN-002 | Galadriel | Publish final envelope/registry/assembler identities, receive limits, loss/reorder/restart semantics, and receiver-side evidence contract. | Preserve explicit disabled/unavailable/failure states; prove exact two-route producer/receiver join, size allow/deny, heartbeat, loss, saturation, and config/executable/registry pins. |
| CR-CREBAIN-003 | Haldir | Publish final receipt/command/gate schemas, canonical bytes, identity/authorization policy, revocation, and effect-evidence contract. | Implement only in a separately reviewed plant adapter. UI, detection, and fusion must be unable to mint authority. Require apply-adjacent state/health/generation checks and SITL/HIL evidence before any authority claim. |
| CR-CREBAIN-004 | pid-rs | Publish the exact observation/statistical contract intended for ecosystem use, including units, time, identity, missingness, and version policy. | Keep local JSONL observation distinct from live NCP/Galadriel delivery; add canonical vectors and preregistered scientific validation before a control or quality claim. |
| CR-CREBAIN-005 | Cross-repo coordinator | Supply final clean local manifests for all five repositories and an acyclic compatibility matrix with exact hashes. | Re-audit changed heads, run downstream conformance on exact pins, and emit a new 1.0 decision. Do not reuse this 0.9 document as convergence evidence. |

Prisoma capture/replay lineage and an authenticated vehicle/FCU deployment are
additional external prerequisites not represented by a final repository
artifact in the supplied five-repository manifest set.
