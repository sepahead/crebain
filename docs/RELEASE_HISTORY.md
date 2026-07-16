# Release history and retired identifiers

This record preserves release identity after obsolete hosted objects are
removed. A retired version or tag must never be recreated or moved.

## 0.9.0 narrow history normalization

Before the 0.9.0 tag was created, one legacy commit message was normalized to
remove wording that is outside the repository's publication vocabulary. The
reconstruction was deliberately narrow: every commit tree, parent order,
author header, committer header, timestamp, and non-target message was
preserved.

- Hosted head before the transition:
  `3e3ee5d0b75269b8f5f634485871069c89a9a474`
- Validated candidate before reconstruction:
  `9df0e07b4d1027c83fa0bd54639eed818557babf`
- Reconstructed candidate:
  `78575c0c2608310d6d5029ef1f5d7ed50ca51181`
- Identical candidate tree:
  `b64345ef5565e0e39c0c701ad02d93820c2959c1`
- Normalized commit mapping:
  `416101255bd861b2542407795d5876bddd3e70c4` to
  `09c7c89e0867bc73fa008f0289aa84d8b69b3494`
- Reachable commits: 202 total; 65 reconstructed because their parent identity
  changed; 137 remained byte-identical.
- Canonical commit-map SHA-256:
  `e8bbff063d37754b8684494e2b7e36faa18f2f70696c4b2ef364af65817a2d3e`

Three existing signature blocks were removed from reconstructed commits because
their signed commit objects necessarily changed. No content, authorship, or
timestamp was changed by that removal. The reconstructed graph passed strict
Git object validation and exact reachable-set comparison before publication.

## `v0.4.0` — retired unpublished draft

- Status: never published; the mutable GitHub draft, its assets, and the remote
  and local tag were removed before the 0.9.0 research-only prerelease.
- Annotated tag object: `759d82156c8a6e078e89d7b95e6024f39944f274`
- Tagged commit: `8ceea521b452df6cbd3b16f04fd244c79b08f1d0`
- Draft release database ID: `339019840`
- Draft target field: `e4598fa7fddb7f5d493beec92856cf171f9a5c22`
- Draft created: `2026-06-13T17:43:39Z`
- Retirement recorded: `2026-07-15`
- Reason: the draft predated the frozen-cut review, contained mutable release
  state, and did not carry the 0.9 evidence, claim boundaries, or complete
  metadata. It is retained here as history, not as an accepted release.

The removed draft assets are recorded only to preserve identity:

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `crebain-0.4.0-1.x86_64.rpm` | 12,846,048 | `7474364561e1210ee2e1893fc87df27c7461fe88af24d9cfa01e55a6a543905d` |
| `crebain_0.4.0_aarch64.dmg` | 19,774,603 | `9b3f114385ab89374b3696eb3fd3d73775870c30cf774b2cdced06107a1cd7f8` |
| `crebain_0.4.0_amd64.AppImage` | 86,772,216 | `5c5cec5c06d42a3a4c513e44f6465ceb7880d33e844203d226e42e46becf026a` |
| `crebain_0.4.0_amd64.deb` | 12,844,714 | `51c4e799dc8f7ae0f885c140439167ad282ed87b7fb658091c27233d21391a34` |
| `crebain_aarch64.app.tar.gz` | 18,924,040 | `4c4696ba3f925c690746c792a62ef63229be6a1e86ba63311855eb4c54edc743` |

No DOI, Zenodo record, published release, or acceptance claim existed for
`v0.4.0`.
