# CREBAIN Public Model Assets

This directory contains static 3D assets served by the frontend, such as
`maverick-drone.glb`. Detection weights are not served from the browser bundle
or committed to this repository.

Native inference models are supplied by the operator through
`CREBAIN_MODEL_PATH`, `CREBAIN_ONNX_MODEL`, experimental
`CREBAIN_MLX_MODEL`, or optional `CREBAIN_MLX_MODEL_SHA256`. Before trusting
any model, record its provenance, tensor contract, class mapping, fixtures, and
benchmark context as described in
[`../../docs/MODEL_CONTRACTS.md`](../../docs/MODEL_CONTRACTS.md).

Do not commit downloaded detection weights. Confirm rights before committing or
redistributing any 3D asset.
