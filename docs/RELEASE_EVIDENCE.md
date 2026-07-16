# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

At preparation time for this source snapshot, no 0.9 release candidate had been
sealed. The stabilization changes had not yet been committed as one immutable
candidate source, tagged, or evaluated by candidate-specific hosted workflows.
Consequently this source document embeds no candidate commit, run identifier,
test count, bundle size, checksum, or package result. After tagging, the release
page, exact-tag workflow, and sealed manifest are authoritative for those
candidate-specific facts; historical results below remain provenance only.

The intended release scope is the research-only prerelease defined by
[`NARROWED_GO_0.9.0.md`](NARROWED_GO_0.9.0.md). It remains NO_GO for operational
use, external-vehicle authority, safety assurance, model accuracy, numeric
performance or fusion claims, deployment qualification, and 1.0 convergence.

| Field | Evidence |
|-------|----------|
| Candidate source commit | Pending final stabilization commit |
| Branch/tag | `main`; an annotated `v0.9.0` tag starts the exact-tag package gate, and the release must remain draft/unpublished unless every gate passes |
| Local validation | Pending final-candidate execution; do not infer a result from an earlier commit |
| Hosted CI, audit, and CodeQL | Pending exact-candidate runs |
| Release workflow and packages | Pending exact-tag prerelease run |
| Manual and deployment evidence | Pending and explicitly outside the narrowed 0.9 claim; required before any operational/demo/1.0 readiness claim |

## Verifying a published evidence archive

GitHub presents release assets in one flat namespace. The release workflow
therefore publishes exactly three standalone application packages (one `.dmg`,
one `.AppImage`, and one `.deb`) plus a metadata-normalized, checksum-sealed
`crebain-<tag>-evidence.tar.gz` archive and its adjacent `.sha256` file. Archive
headers are normalized, but independently rebuilt packages, logs, and Syft
generation metadata are not claimed byte-reproducible across workflow reruns.
The archive preserves the sealed `application/` and `evidence/` directories,
`SHA256SUMS`, and `RELEASE_EVIDENCE_MANIFEST.json`; no flat release asset is
substituted for one of those manifest paths. GitHub attestations bind both the
standalone packages and the sealed archive produced by the exact-tag workflow.

From a system with Bash, GitHub CLI, Git, `jq`, Node.js, Python 3, GNU
`sha256sum`, and `tar`, the following verifies the archive checksum, exact tagged
source identity, complete manifest inventory, internal checksums, and byte
equality between the three standalone packages and their sealed archive copies:

```bash
set -euo pipefail
TAG=v0.9.0
VERSION="${TAG#v}"
test "$TAG" = "v$VERSION"
VERIFY_DIR="$(mktemp -d)"
ARCHIVE="crebain-${TAG}-evidence.tar.gz"
PACKAGES=(
  "crebain_${VERSION}_aarch64.dmg"
  "crebain_${VERSION}_amd64.AppImage"
  "crebain_${VERSION}_amd64.deb"
)
mkdir -p "$VERIFY_DIR/assets" "$VERIFY_DIR/evidence-root"
git clone --branch "$TAG" --depth 1 https://github.com/sepahead/crebain.git "$VERIFY_DIR/source"
COMMIT="$(git -C "$VERIFY_DIR/source" rev-parse HEAD)"
"$VERIFY_DIR/source/scripts/check-version-coherence.sh" --expected-commit "$COMMIT" "$TAG"
test "$(gh release view "$TAG" --repo sepahead/crebain --json tagName --jq .tagName)" = "$TAG"
test "$(gh release view "$TAG" --repo sepahead/crebain --json isDraft --jq .isDraft)" = false
test "$(gh release view "$TAG" --repo sepahead/crebain --json isPrerelease --jq .isPrerelease)" = true
gh api "repos/sepahead/crebain/releases/tags/$TAG" \
  -H 'X-GitHub-Api-Version: 2026-03-10' > "$VERIFY_DIR/release-state.json"
jq -e --arg tag "$TAG" \
  '.tag_name == $tag and .draft == false and .prerelease == true and .immutable == true' \
  "$VERIFY_DIR/release-state.json" > /dev/null
gh release view "$TAG" --repo sepahead/crebain --json assets --jq '.assets[].name' \
  | LC_ALL=C sort > "$VERIFY_DIR/release-assets.txt"
printf '%s\n' "${PACKAGES[@]}" "$ARCHIVE" "$ARCHIVE.sha256" \
  | LC_ALL=C sort > "$VERIFY_DIR/expected-assets.txt"
cmp "$VERIFY_DIR/expected-assets.txt" "$VERIFY_DIR/release-assets.txt"
gh release download "$TAG" --repo sepahead/crebain --dir "$VERIFY_DIR/assets" \
  --pattern "$ARCHIVE" --pattern "$ARCHIVE.sha256" \
  --pattern "${PACKAGES[0]}" --pattern "${PACKAGES[1]}" --pattern "${PACKAGES[2]}"
gh attestation verify "$VERIFY_DIR/assets/$ARCHIVE" --repo sepahead/crebain \
  --signer-workflow sepahead/crebain/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" --deny-self-hosted-runners
for package in "${PACKAGES[@]}"; do
  gh attestation verify "$VERIFY_DIR/assets/$package" --repo sepahead/crebain \
    --signer-workflow sepahead/crebain/.github/workflows/release.yml \
    --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" --deny-self-hosted-runners
done
(cd "$VERIFY_DIR/assets" && sha256sum --check "$ARCHIVE.sha256")
tar -xzf "$VERIFY_DIR/assets/$ARCHIVE" -C "$VERIFY_DIR/evidence-root"
python3 "$VERIFY_DIR/source/scripts/verify-evidence-manifest.py" \
  "$VERIFY_DIR/evidence-root/RELEASE_EVIDENCE_MANIFEST.json" \
  --root "$VERIFY_DIR/evidence-root" --expected-commit "$COMMIT"
(cd "$VERIFY_DIR/evidence-root" && sha256sum --check SHA256SUMS)
for package in "${PACKAGES[@]}"; do
  cmp "$VERIFY_DIR/evidence-root/application/$package" "$VERIFY_DIR/assets/$package"
done
```

The release remains a draft until its exact-tag workflow succeeds. A rerun
never reads application or evidence bytes from an existing draft: it consumes
only SHA/run-scoped artifacts from that workflow run. Partial failed-job reruns
reuse successful predecessor artifacts under the same names; full reruns
replace those same-run artifacts before dependents execute. The publisher
removes only an earlier draft prerelease for the exact tag, creates a fresh
draft, rechecks the annotated tag target, and compares every uploaded byte with
the sealed run artifact. Only then does its final step publish the release as a
non-latest prerelease. The PATCH response and an exact-ID refetch must both show
`immutable: true` as well as the exact tag, public prerelease state, and five-asset
inventory. This follows GitHub's
[immutable-release workflow](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases):
all bytes are attached and verified while the release is still a draft, before
publication locks its assets and tag. If publication remains mutable or its
state/inventory check fails, the job fails. A mutable or unknown publication
gets a best-effort return-to-draft attempt; an immutable publication cannot be
returned to draft, so the job emits a reconciliation warning and preserves the
failure until the exact hosted state is reviewed.

## Pre-producer frame-convention snapshot (`49d7b36`, not current evidence)

Immediately before the Galadriel producer commits, commit
`49d7b3614f24d21a40fe2af6dbeac082338ae9d7` passed
[CI 29234674954](https://github.com/sepahead/crebain/actions/runs/29234674954),
[Audit 29234675080](https://github.com/sepahead/crebain/actions/runs/29234675080),
[CodeQL 29234675050](https://github.com/sepahead/crebain/actions/runs/29234675050),
and [OpenSSF Scorecard 29234674958](https://github.com/sepahead/crebain/actions/runs/29234674958).
Its exact local validation covered 297 frontend tests, 273 default and 311
NCP-feature all-target Rust tests (including 22 benchmark tests in each total),
57 plant tests, 147 production files, 112 Phase-0 negative fixtures, and 20
frame-corpus mutations. Those results establish the inactive plant contract and
digest-bound 32-case JavaScript/Rust frame-convention corpus at that commit;
they do not cover the later producer source, routes, manifests, receiver, or
deployment boundary and are not current-candidate evidence.

## Pre-producer plant-contract snapshot (`33e5ef3a`, not current evidence)

Immediately before Galadriel producer integration changed executable source and
manifests, commit `33e5ef3a9a3e8239a7fea902f3122d307b8d8aee`
had the following exact evidence. These results preserve provenance for the
inert plant contract, native benchmark, and serialized IPC work, but none of
the runs or counts may be reused for the producer-integrated candidate.

| Field | Historical evidence |
|-------|---------------------|
| Branch/tag | `main`; no release tag |
| Hosted CI | [CI 29231759604](https://github.com/sepahead/crebain/actions/runs/29231759604) passed on the exact snapshot source |
| Supply chain | [Audit 29228207144](https://github.com/sepahead/crebain/actions/runs/29228207144) passed on `cf76017e9304f408561106f440496f39b745b8a5`, the last dependency-manifest change in that snapshot |
| Static/policy | [CodeQL 29231759633](https://github.com/sepahead/crebain/actions/runs/29231759633) passed for Rust and JavaScript/TypeScript, and [OpenSSF Scorecard 29231759534](https://github.com/sepahead/crebain/actions/runs/29231759534) passed |
| Local validation | `bun run validate:all` passed: 297 frontend tests; 273 default all-target Rust tests (251 library plus 22 benchmark) plus one ignored fixture generator; 311 NCP-feature all-target Rust tests (289 library plus 22 benchmark) plus one ignored fixture generator; 48 plant tests; strict default/NCP/plant Clippy and Rustfmt; 146 production files; 110 Phase-0 negative fixtures |
| MSRV | Rust 1.89 `cargo check --locked --all-targets` passed; development and CI remained pinned to 1.91.1 |
| Frontend/bundle | Local tests and `bun run check:bundle` passed; hosted validation, coverage thresholds, artifact scanner, and bundle budget passed; initial bundle 431.8/700 KiB |
| Rust feature matrix | Local default/NCP all-target suites passed; hosted Linux/macOS default/NCP jobs plus Linux `cuda,tensorrt` and `--no-default-features` checks passed |
| Evidence boundary | The one production Tauri handler list drove mock-runtime negative IPC tests for scene, detector, fusion, and transport inputs. The isolated inert plant package covered bounded command/output channels, retained whole-value snapshots, passive generation-bound monotonic expiry, and inactive contract-v1 validation for a closed ENU/NED profile kind and artifact digest, frame-retaining SI velocity, session/generation/sequence, producer correlation time, plant-local receipt time, draft speed/TTL limits, and rejection of unsupported action classes. The contract had no parser, transport, stateful replay gate, active expiry, trusted health gate, safe-action selector, governor, adapter, or action path; its profile and limits remained unapproved. Native benchmark mechanics covered bounded inputs, exact metric scope, content identity, trusted-baseline binding, and explicit report limits. No approved model, numeric result, target run, packaged-origin/CSP/capability proof, positive smoke, trusted health schema, active watchdog, apply-time governor, or per-session action ownership was established. |

## Pre-producer benchmark/IPC snapshot (`266ff810`, not current evidence)

Before Galadriel producer integration changed executable source and manifests,
commit `266ff810256d9a9563c3a3a1e976e81f81067aeb` had the following exact evidence.
It preserves provenance for the native benchmark and serialized IPC work, but
none of these runs or counts may be reused for the current candidate.

| Field | Historical evidence |
|-------|---------------------|
| Hosted CI | [CI 29229090775](https://github.com/sepahead/crebain/actions/runs/29229090775) passed on `266ff810256d9a9563c3a3a1e976e81f81067aeb` |
| Supply chain | [Audit 29228207144](https://github.com/sepahead/crebain/actions/runs/29228207144) passed on `cf76017e9304f408561106f440496f39b745b8a5`, the last dependency-manifest change in that snapshot |
| Static/policy | [CodeQL 29229090753](https://github.com/sepahead/crebain/actions/runs/29229090753) and [OpenSSF Scorecard 29229090763](https://github.com/sepahead/crebain/actions/runs/29229090763) passed |
| Local validation | 297 frontend tests; 273 default all-target Rust tests (251 library plus 22 benchmark) plus one ignored fixture generator; 311 NCP-feature all-target Rust tests (289 library plus 22 benchmark) plus one ignored fixture generator; 40 plant tests; strict default/NCP/plant Clippy and Rustfmt; 145 production files; 110 Phase-0 negative fixtures |
| MSRV | Rust 1.89 `cargo check --locked --all-targets` passed; development and CI were pinned to 1.91.1 |
| Frontend/bundle | Local tests and `bun run check:bundle` passed; hosted validation, coverage, artifact scanner, and bundle budget passed; initial bundle 431.8/700 KiB |
| Rust feature matrix | Local default/NCP all-target suites and hosted Linux/macOS default/NCP jobs passed; Linux `cuda,tensorrt` and `--no-default-features` checks passed |
| Evidence boundary | The production handler list drove negative mock-runtime IPC tests for scene, detector, fusion, and transport inputs. Native benchmark mechanics covered bounded inputs, model/fixture/runtime identity, raw samples, trusted-baseline digest binding, p95 comparison, and atomic no-overwrite reports. No approved model, target-hardware run, baseline, threshold, numeric result, packaged-origin/CSP/capability proof, positive path, or target-platform smoke was established. |
## Historical Snapshot (`e89de5a`, not current evidence)

The previous candidate passed [CI 29118711312](https://github.com/sepahead/crebain/actions/runs/29118711312),
[CodeQL 29118711301](https://github.com/sepahead/crebain/actions/runs/29118711301),
and [OpenSSF Scorecard 29118711298](https://github.com/sepahead/crebain/actions/runs/29118711298)
on commit `e89de5acc2eb7d66b807f85dc407f3da0e35892c`. The separate
[Supply-chain run 29104945725](https://github.com/sepahead/crebain/actions/runs/29104945725)
ran on `5dec6037fe1fa461fae76083d682be35ae5352ab`; it is not attributed to the
`e89de5a` source identity. None of these historical results may be reused as
evidence for the current dependency or source tree.

## Current 0.9 automated evidence required

The final candidate must record exact results rather than copied counts or run
identifiers. Until the stabilization tree is committed, every status below is
pending.

| Area | Required exact-candidate evidence | Current status |
|------|-----------------------------------|----------------|
| Source identity | Final commit, direct annotated `v0.9.0` tag, and coherent 0.9.0 metadata | Pending final commit and tag |
| Local validation | `bun run validate:all`, `bun run test:coverage`, `bun run check:bundle`, `bun run check:vendor-compat`, `bun run check:nix-deps`, and `git diff --check` | Pending final-candidate run |
| Hosted source gates | CI, ROS, audit, CodeQL, and Nix workflows on the exact candidate | Pending hosted runs |
| Release gate | Locked validation, coverage, bundle, cargo-deny, Bun audit, vendor provenance, clean Nix package, Linux/macOS packages, SBOM, checksums, hierarchy-preserving digest-manifest archive, package/archive provenance attestations, fresh draft byte comparison, and post-publication native-immutability/state/inventory verification | Pending exact-tag prerelease run |
| Evidence capture | Candidate-specific outputs, package identities, checksums, and hosted run URLs | Pending; no earlier count or run is current evidence |

## Historical automated snapshot (`844e80a`, not current evidence)

Every status in the table below applies only to commit
`844e80a1aa76028814ecb012bb26269ae7a44410`. The requirements remain useful,
but none of its results, counts, or hosted runs is evidence for the 0.9 tree.

| Area | Required evidence | Historical status |
|------|-------------------|-------------------|
| Version coherence | Metadata/tag guard on candidate | Local exact-source and hosted CI checks passed; no release tag exists |
| Frontend validation | Typecheck, lint, format, and tests | Local exact-source checks and hosted frontend job passed; 45 files / 305 tests |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Local bundle passed at 432.3/700.0 kB gzipped; hosted coverage and bundle jobs passed |
| Rust default | fmt, check, all-target tests, and clippy on Linux/macOS | Local exact-source suite and hosted Linux/macOS jobs passed |
| NCP bridge/producer feature | Locked NCP clippy and all-target tests on Linux/macOS, including registry/config/executable pins, readiness-only config immutability, exact-time/channel state, bounded measurement/track admission, invalid-gate refusal, sparse/all-infinite assignment, codecs, upstream/queue degradation, heartbeat, lifecycle, and JSONL archive failure semantics | Local 411-test suite plus one ignored generator and hosted Linux/macOS jobs passed; component complexity tests are not target deadline evidence |
| Inert plant foundation | Dependency boundary, exact crate-root/API inventory, sealed-health/freshness/safe-action/deadline-monitor/apply-observation static mutation checks, compile-fail endpoint/ownership/conversion/ticket/monitor/observation checks, strict Clippy, property/stress/headless/retained-snapshot/expiry/contract/frame/health/freshness/safe-action/deadline/apply-observation tests, digest-bound cross-language frame corpus, and self-check | Exact source passed locally and in the hosted plant job: 123 unit/integration tests plus 24 compile-fail doctests, 231 plant-boundary mutations (64 health/freshness, 51 safe-action, 72 deadline-monitor, and 44 apply-observation), 32 frame cases, and 20 frame mutations. The safe-action evidence is only an inert exact-profile, opaque-code, no-default lookup over caller-proposed rows; it is not profile content binding, authoritative state classification, an approved ODD matrix, action conversion, or a physical response. The deadline evidence is only an unwired per-monitor one-slot fixed-state worker that detects/timestamps an immutable receipt-anchored deadline when scheduled; copyable candidates can mint multiple tickets, and neither monitor uniqueness nor the global monitor count is enforced. It is not trusted admission/currentness, an operational watchdog, output revocation, an action/effect, scheduler/suspend/latency qualification, or SITL/HIL evidence. The apply observation loads one coherent retained health snapshot before minting its private reference instant, then computes health ages, command age, and policy mismatch. Its neutral facts do not authorize even when construction succeeds; it does not bind vehicle, local-frame instance, or command content, can be reminted, may become stale immediately, and is not adjacent to an output write or revocation path. This is partial CB-027/CB-028/CB-029/CB-030/CTL-005/HAZ-003/HAZ-006/HAZ-007/HAZ-012 component evidence only—CTL-003, CTL-007, `TEST-ATOMIC-STATE-STALENESS`, and `TEST-PLANT-LOCAL-TTL` remain planned, while HAZ-003 and HAZ-012 remain partial and HAZ-007 remains open; no authenticated FCU state, real aggregation coherence, approved freshness/safety/TTL policy, authorizing current/apply-time gate, durable epoch ownership, operational watchdog, apply-time governor, adapter, or live authority exists |
| Serialized native IPC | Same production handler list plus negative structured invokes for scene, detector, fusion, and transport input boundaries | Exact-source local suite and hosted frontend/Rust checks passed; `InvokeRequest` mock-runtime evidence does not replace raw webview conversion, packaged-origin/CSP/capability, positive-path, or target-platform smoke evidence |
| Native detector benchmark mechanics | All-target/focused tests cover bounds, failure propagation, model/fixture identity, ONNX Runtime loading records and configured-Linux-library identity, raw-sample summaries, exact millisecond-to-FPS conversion, trusted-baseline digest binding/comparability, and no-overwrite report persistence | The exact-source default and NCP suites each passed all 22 logic tests; no approved model, target-hardware run, baseline, threshold, or numeric result exists |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Hosted exact-source Linux feature-gate job passed |
| Supply chain | cargo-deny and `bun audit` | Audit 29242246397 passed on the last dependency-manifest change `09dd5ec`; source `844e80a` has no audit-workflow manifest diff |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Exact-source CodeQL 29273670797 passed for both languages on attempt 1 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed on the source tree; evidence-only diff is checked separately before its commit |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Serialized negative IPC cases passed; positive target-platform smoke remains pending |
| ROS 1 / Gazebo Classic | Read-only telemetry on the recorded Zenoh or development/native rosbridge topology; removed publish/service paths remain absent | Pending |
| Native Zenoh | Typed message surface plus explicit unsupported-path behavior | Pending |
| Galadriel producer deployment | Exact post-package executable/config/registry; two-key TLS principal/ACL allow+deny and CN→`producer_id` binding; router/receiver receive-size allow+oversize-deny; receiver decode/join; heartbeat/loss/reorder/restart/saturation/clock/combined-load/shutdown traces; producer logs for numeric upstream/track-cap loss | Pending external topology |
| Plant health and effect boundary | Authenticated FCU collector/source; multi-message coherence with oldest-constituent time; frame-reset identity; durable epoch ownership; approved freshness/TTL policy plus authoritative situation classification and a content-bound safe-action matrix; immediately-before-write generation/health checks and output revocation; operational watchdog, governor, adapter, and SITL/HIL traces | Pending external vehicle/profile/topology and later plant components; the opaque situation-dispatch candidate, unwired fixed-state deadline monitor, and non-authorizing apply-check observation do not satisfy these gates |
| Model contract | Approved artifact digest, tensors, class mapping, fixtures, and rights | Pending external artifact |
| Performance | Candidate-specific hardware/model/command evidence for every numeric claim | No numeric claim approved yet |

## External evidence boundaries

- Hardware-in-the-loop and real autopilot behavior need the target vehicle stack.
- Direct ROS 2 `rmw_zenoh_cpp` interoperability needs a deployed re-keying bridge.
- Zenoh TLS/ACL evidence needs the deployment certificates and topology.
- NCP's action bridge remains dormant and needs explicit runtime wiring plus a
  compatible Engram/realm/ACL deployment before any live action-loop claim.
- The Galadriel producer runtime is wired only under its two gates. It still
  needs an authenticated exact-route topology, verified receive-size policy, and
  compatible receiver-side assembler/registry/deadline/loss evidence before a
  live ecosystem claim. Sparse-assignment and bounded-admission component tests
  do not prove combined-process timing, and numeric upstream/cluster loss remains
  producer-log-only in the current wire contract.
- PID JSONL proves only local append/parser/basic NIS behavior; it is not evidence
  of Galadriel correlation, PID control, ACL, versioned streaming, or live NCP.
  Its active capacity-16 archive/drop/degradation behavior and blocked-writer
  shutdown limit still need candidate-specific storage evidence.
- The vehicle-health component has a closed immutable in-memory schema and
  coherent age mechanics, while the separate exact-profile-bound classifier
  compares only ages frozen at one read against caller-proposed exclusive
  limits. Neither component establishes current/apply-time freshness or health;
  the source, frame, and profile identities are declared, not authenticated or
  adapter-attested. They still need real FCU aggregation, durable epoch
  ownership, approved freshness/safe-action policy, apply-time checks,
  watchdog/governor/adapter mechanics, and SITL/HIL traces.
- The safe-action situation-dispatch candidate owns a bounded no-default table
  over caller-proposed opaque codes and a closed plant-intent vocabulary. The
  asserted profile identity does not content-bind those rows, and no
  authoritative state/trigger classifier, overlap precedence, health/time/
  lifecycle input, action conversion, runtime consumer, adapter transaction,
  FCU acknowledgement, or observed effect exists. It is not evidence that Hold,
  Land, RTL, inhibit, or ground disarm is safe in any operational state.
- The deadline-monitor candidate owns one fixed stream slot and derives an
  immutable deadline from opaque plant-local receipt time plus a bounded local
  TTL proposal. That slot is per monitor only: the copyable candidate can mint
  multiple tickets, and no global monitor-instance bound or uniqueness rule is
  enforced. It can timestamp deadline observation when its worker is scheduled,
  but it is unwired and neither authenticates admission/currentness nor revokes
  output or causes an action/effect. Caller-reported generation mismatch is not
  autonomous lifecycle observation. No scheduler reservation, suspend-inclusive
  clock qualification, latency bound, process-loss containment, or SITL/HIL
  evidence exists, so this is not an operational watchdog claim and HAZ-012
  remains partial.
- The apply-check observation loads one retained health snapshot before minting
  one private reference instant and computes health ages before command age and
  policy mismatch. Construction success is deliberately neutral for expired
  commands, every lifecycle state, and stale/unknown/unavailable health. Its
  facts are individually comparable, but it exposes no direct aggregate
  boolean and conveys no authorization. Exact structural profile and generation
  matching cannot bind a command to the health snapshot's vehicle or local
  frame because the command carries neither identity; retained identifiers and
  TTL also do not bind command content or velocity. The observation can be
  reminted and become stale immediately, and it has no output-write adjacency,
  revocation, action conversion, adapter, or observed effect. CTL-003 and
  `TEST-ATOMIC-STATE-STALENESS` remain planned, while CTL-005 remains partial.
- Model and accuracy evidence needs an approved immutable model plus fixture data.

## Related documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/NATIVE_DETECTOR_BENCHMARK.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `docs/PLANT_FRESHNESS_V1.md`
- `docs/PLANT_HEALTH_V1.md`
- `docs/PLANT_APPLY_OBSERVATION_V1.md`
- `docs/PLANT_SAFE_ACTION_V1.md`
- `docs/PLANT_WATCHDOG_V1.md`
- `SECURITY.md`
