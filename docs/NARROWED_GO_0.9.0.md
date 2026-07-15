# CREBAIN 0.9.0 release decision

Decision: **NARROWED_GO for a research-only prerelease**.

Decision owner and author: Sepehr Mahmoudian. Decision date: 2026-07-14.

This is simultaneously **NO_GO** for operational use, deployment qualification,
external-vehicle authority, safety assurance, model accuracy, numeric fusion or
latency claims, field validation, and SEPAHEAD cross-repository 1.0 convergence.
The narrower decision is intentional; it is not an intermediate 1.0 acceptance.

## What 0.9.0 may claim

- The exact frozen source cut was inventoried and every tracked file was assigned
  and read in three separate agent review contexts. Those contexts share one
  coordinator and are not independent human or organizational review.
- The 0.9 product-profile registry gives every profile `authority: none`.
  Packaged transport is bounded telemetry; local simulation may mutate only
  simulated state. The plant-authority package remains separate, inert, and
  unwired.
- The frontend/backend IPC registry, Phase-0 source inventory, production module
  graph, emitted chunks, CSP, and capability scanners guard the documented
  no-authority and development-module boundaries.
- Automated source, parser, estimator, transport, lifecycle, physics, scene,
  supply-chain, coverage, and package-build gates are reproducible commands.
  Candidate-specific outputs and checksums belong to the hosted release evidence
  manifest; this document does not predict their result.
- No model weights or third-party 3D model are bundled. The built-in drone visual
  is procedural.

## What 0.9.0 does not claim

- No live FCU/autopilot command, apply, acknowledgement, or observed-effect path.
- No Haldir gate, final NCP/Engram 1.0 migration, final Galadriel contract,
  Prisoma lineage export, or five-repository convergence manifest.
- No TLS, mTLS, ACL, certificate, receiver-delivery, router-size, or secure
  deployment proof. Loading a configuration and completing a local put are not
  those proofs.
- No approved model provenance/tensor/class/accuracy package and no target-device
  CoreML, CUDA, TensorRT, or MLX performance result.
- No SITL, HIL, long-duration target-hardware, suspend/resume, field, or manual
  packaged-GUI qualification.
- No independent clean-room build or independent critical-evidence reproduction.
- No cryptographic tag signature is claimed. Hosted artifact attestations, when
  present, identify workflow-built files but do not replace independent review.
- No DOI or Zenodo record has been assigned. Neither a placeholder nor an
  invented citation identifier is included.

## Blocking 1.0 dependencies

The handoff tasks requiring final Haldir, NCP/Engram, Galadriel, Prisoma,
deployment topology, hardware, independent review, or cross-repository outputs
remain open. In particular T144–T148, T153, and T156 cannot be closed by edits to
CREBAIN alone. Because the supplied 1.0 ledger is a strict dependency chain,
downstream T149–T158 are not represented as completed 1.0 tasks even when their
0.9 source-level subset was performed.

## Release conditions

The annotated `v0.9.0` tag must point directly at the expected commit and every
published metadata source must equal 0.9.0. The release workflow must pass its
locked validation, coverage, bundle, cargo-deny, Bun audit, vendor provenance,
clean Nix package, Linux/macOS package, checksum, SBOM, digest-manifest, and
provenance steps. The hosted release remains a prerelease and must preserve this
decision text. Any failed gate returns the candidate to NO_GO.

Manual/deployment rows in `RELEASE_ACCEPTANCE.md` and `MANUAL_SMOKE_TEST.md`
remain pending. A later DOI/Zenodo update or 1.0 effort must be a new immutable
version; it must not move or recreate the 0.9.0 tag.
