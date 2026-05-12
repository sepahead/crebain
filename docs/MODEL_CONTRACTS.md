# CREBAIN Model Contracts

CREBAIN does not ship model weights. Any model used for demos, benchmarks, or release validation must be treated as externally supplied input until its file path, rights, tensor contracts, preprocessing, postprocessing, and class mapping are verified.

## Required Model Record

| Field | Required Information |
|-------|----------------------|
| Model name/version | Family, training/export version, and source repository or internal provenance |
| File path | Local path and expected extension (`.onnx`, `.mlmodelc`, or `.safetensors`) |
| Rights | Confirmation that the model can be used and redistributed for the intended purpose |
| Input tensor | Name, shape, dtype, channel order, normalization, resize/crop behavior |
| Output tensors | Names, shapes, dtype, coordinate convention, confidence/objectness semantics |
| Class mapping | Index-to-label table mapped into CREBAIN `DetectionClass` values |
| Postprocessing | NMS, score thresholding, coordinate scaling, and max detections behavior |
| Validation data | Fixture images or frames used to verify expected detections |
| Benchmark context | Hardware, OS, backend, model file, thresholds, and command used |
| Failure behavior | Expected behavior for missing, malformed, wrong-extension, or unsupported model/build inputs |

## Backend-Specific Expectations

| Backend | Contract Notes |
|---------|----------------|
| Browser ONNX (`YOLODetector`, `RFDETRDetector`, `CoreMLDetector`) | Validate ONNX Runtime Web execution providers, tensor names, preprocessing, and whether output tensors are raw or post-processed. |
| Native CoreML | Use `.mlmodelc` directories through the Rust/Tauri backend. Confirm Vision/CoreML input handling, class labels, and coordinate conversion before trusting detections. |
| ONNX Runtime Native | Validate `CREBAIN_ONNX_MODEL` or `CREBAIN_MODEL_PATH`, expected `.onnx` extension, execution provider availability, and structured failure payloads. |
| CUDA / TensorRT | Treat acceleration choice as deployment-dependent. Record hardware, driver/runtime versions, TensorRT cache settings, `.onnx` input path, `.engine` output path, and benchmark command before making performance claims. INT8 engine building requires calibration data and is not supported by the current build command. |
| MLX | Experimental opt-in YOLOv8 safetensors path. `CREBAIN_MLX_MODEL` must point to a validated `.safetensors` file, and `CREBAIN_MLX_MODEL_SHA256` can pin an expected SHA-256 digest. Do not use MLX output as release evidence until the external model file, tensor names, class mapping, fixture detections, and target-hardware benchmarks are recorded. |
| Moondream | Vision-language prompts and parsed text output are heuristic. Treat bounding boxes and confidence as approximate unless validated against fixtures. |

## Minimum Acceptance Before Trusting Detections

1. Model path validation succeeds without traversal, null bytes, missing files, or unexpected extensions.
2. At least one fixture frame produces expected class labels and bounding boxes within documented tolerance.
3. Empty/no-target frames do not produce systematic false positives under the chosen thresholds.
4. Confidence thresholding and max-detection limits behave consistently across frontend/backend paths used by the scenario.
5. Any benchmark result includes target hardware, model file, backend, command, threshold settings, and whether benchmark tests were explicitly enabled.
