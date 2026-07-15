# Hash-verified compatibility overlays

Zenoh 1.9 selects `flume 0.11.1`, `uhlc 0.8.2`, and
`buddy_system_allocator 0.10.0`. Their published manifests constrain `spin` to
versions which crates.io later yanked after synchronization soundness fixes.
CREBAIN patches these three exact upstream packages locally and resolves their
existing `spin` feature sets against `spin 0.12.2`.

Zenoh 1.9 also declares `lz4_flex 0.10.0` unconditionally even though every use
of that crate is guarded by Zenoh's `transport_compression` feature. CREBAIN
disables Zenoh defaults and does not enable transport compression. The exact
`zenoh-transport 1.9.0` overlay therefore makes that dependency optional and
connects it to the existing feature. This removes LZ4 from the selected lock and
compiled graph while preserving Zenoh's behavior and its dormant feature.

The only edits to these four upstream source trees are dependency versions and
feature wiring in their generated `Cargo.toml` files. Resolving the constraints against
`spin 0.12.2` necessarily changes the transitive synchronization implementation;
it does not change source, APIs, algorithms, or selected features inside the
three synchronization overlay crates. `PROVENANCE.json` records the crates.io archive hashes,
every upstream file hash, licenses, the exact replacements, and the resulting
manifest hashes. The four small hash-verified source archives are retained in
`upstream-archives/`, so verification is offline and cannot be bypassed by
editing the manifest alongside a source file. Verify with:

```bash
python3 scripts/verify-vendor-compat.py
cargo deny --manifest-path src-tauri/Cargo.toml check
```

To reproduce the provenance manifest, download the four named `.crate` files
from their recorded `archive_url` values into a trusted temporary directory,
verify their recorded archive hashes out of band, and run:

```bash
python3 scripts/verify-vendor-compat.py --refresh-from /path/to/archives
```

These overlays are temporary supply-chain compatibility measures, not forks or
upstream security endorsements. Remove each overlay only after the selected
Zenoh dependency graph no longer needs it and all default/NCP tests and denial
gates pass without it. Enabling transport compression requires first adopting
a fixed LZ4 release and revalidating the graph.
