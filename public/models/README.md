# CREBAIN Public Model Assets

This directory is reserved for static 3D assets whose source, license,
retrieval date, modifications, and immutable digest are documented. CREBAIN
0.9.0 ships no third-party 3D model; the simulation uses a procedural drone
mesh. Detection weights are not served from the browser bundle or committed to
this repository.

Native inference models are supplied by the operator through
`CREBAIN_MODEL_PATH`, `CREBAIN_ONNX_MODEL`, experimental
`CREBAIN_MLX_MODEL`. The optional `CREBAIN_MLX_MODEL_SHA256` pins the digest of
the MLX model selected by `CREBAIN_MLX_MODEL`; it is not a model path. Before
trusting any model, record its provenance, tensor contract, class mapping,
fixtures, and benchmark context as described in
[`../../docs/MODEL_CONTRACTS.md`](../../docs/MODEL_CONTRACTS.md). The native
latency artifact and its evidence limits are documented in
[`../../docs/NATIVE_DETECTOR_BENCHMARK.md`](../../docs/NATIVE_DETECTOR_BENCHMARK.md).

Do not commit downloaded detection weights. Do not commit or redistribute a 3D
asset until its rights and provenance record has been reviewed.
