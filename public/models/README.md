# CREBAIN public model assets

This directory is reserved for static 3D assets whose source, license,
retrieval date, modifications, and immutable digest are documented. CREBAIN
0.9.0 ships no third-party 3D model. The simulation uses a procedural drone
mesh. Detection weights are not served from the browser bundle or committed to
this repository.

The operator supplies native inference models through `CREBAIN_MODEL_PATH`,
`CREBAIN_ONNX_MODEL`, or the experimental `CREBAIN_MLX_MODEL` variable. The
optional `CREBAIN_MLX_MODEL_SHA256` pins the selected MLX model digest. It is
not a model path. Before
trusting any model, record its provenance, tensor contract, class mapping,
fixtures, and benchmark context as described in
[`../../docs/MODEL_CONTRACTS.md`](../../docs/MODEL_CONTRACTS.md). The native
latency artifact and its evidence limits are documented in
[`../../docs/NATIVE_DETECTOR_BENCHMARK.md`](../../docs/NATIVE_DETECTOR_BENCHMARK.md).

Do not commit downloaded detection weights. Do not commit or redistribute a 3D
asset until a reviewer approves its rights and provenance record.
