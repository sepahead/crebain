# CREBAIN Model Contracts

CREBAIN does not ship model weights. Treat every demo, benchmark, or release
model as untrusted external input until its provenance, tensor contract,
preprocessing, postprocessing, and class mapping have been verified.

## Required Model Record

| Field | Required information |
|-------|----------------------|
| Model name/version | Family, training/export version, source repository, and immutable digest |
| File path | Local path and expected extension (`.onnx`, `.mlmodelc`, or `.safetensors`) |
| Rights | Confirmation that the model can be used and redistributed for the intended purpose |
| Input tensor | Name, shape, dtype, channel order, normalization, and resize/crop/letterbox behavior |
| Output tensors | Names, shapes, dtype, coordinate convention, and confidence/objectness semantics |
| Class mapping | Complete model index-to-label table and the explicit mapping into CREBAIN's tactical taxonomy |
| Postprocessing | NMS, score thresholding, coordinate scaling, and maximum-detection behavior |
| Validation data | Golden fixture images/frames with expected classes and bounding boxes |
| Benchmark context | Hardware, OS, backend, exact model digest, thresholds, and command |
| Failure behavior | Missing, malformed, wrong-extension, wrong-shape, and unsupported build inputs |

## Current native YOLO contract

The shared native YOLOv8 ONNX/TensorRT postprocessor is not class-count
agnostic. It accepts one batch with exactly 84 features per anchor:

- `[1, 84, N]` or `[1, N, 84]`;
- four box values `(cx, cy, w, h)` followed by 80 class scores;
- the repository's fixed COCO-80 index order; and
- the backend's documented 640×640 preprocessing path.

CREBAIN's five tactical labels (`drone`, `bird`, `aircraft`, `helicopter`, and
`unknown`) are downstream application categories. They do not change this tensor
shape. In particular, Manwe's five-class `[1,9,N]` export is **not** a drop-in
native model: an adapter must define preprocessing, reshape/class semantics,
COCO-to-tactical replacement behavior, error handling, and golden fixtures before
that model can be enabled.

The experimental MLX path consumes YOLOv8 safetensors and performs DFL decoding;
it remains opt-in until an approved external artifact and fixtures prove its
weight names, layer shapes, class order, and results. Do not infer parity merely
from both paths using the YOLOv8 name.

## Backend-specific expectations

| Backend | Contract notes |
|---------|----------------|
| Native CoreML | Use a validated `.mlmodelc` directory. Confirm Vision/CoreML input handling, model labels, coordinate conversion, and fixture results. |
| ONNX Runtime Native | Validate `CREBAIN_ONNX_MODEL` or `CREBAIN_MODEL_PATH`, the `.onnx` extension, execution provider, 84-feature COCO contract, and structured failure path. |
| CUDA / TensorRT | Record hardware, driver/runtime versions, cache settings, ONNX input, engine output, and benchmark command. INT8 engine building needs calibration data and is not supported by the current build command. |
| MLX | Experimental opt-in path. `CREBAIN_MLX_MODEL` must be a validated `.safetensors` file; `CREBAIN_MLX_MODEL_SHA256` may pin its digest. No release evidence without artifact provenance, tensor/class fixtures, and target-hardware benchmarks. |

## Minimum acceptance before trusting detections

1. Path validation rejects traversal, null bytes, missing files, and unexpected extensions.
2. The exact input and output shapes match the selected implementation before postprocessing.
3. Golden target frames produce expected labels and boxes within a documented tolerance.
4. Empty/no-target frames do not produce systematic false positives at the chosen thresholds.
5. Threshold and maximum-detection behavior agree across every runtime path used by the scenario.
6. Benchmarks record hardware, model digest, backend, invocation, thresholds, and fixture inputs.
