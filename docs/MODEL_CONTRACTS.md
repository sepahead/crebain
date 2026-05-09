# CREBAIN Model Contracts

CREBAIN does not ship model weights. Any model used for demos, benchmarks, or release validation must be treated as externally supplied input until its file path, input tensor contract, output tensor contract, preprocessing, postprocessing, and class mapping are verified.

## Required Model Record

| Field | Required Information |
|-------|----------------------|
| Model name/version | Family, training/export version, and source repository or internal provenance |
| File path | Local path and expected extension (`.onnx` or `.mlmodelc`) |
| Rights | Confirmation that the model can be used and redistributed for the intended purpose |
| Input tensor | Name, shape, dtype, channel order, normalization, resize/crop behavior |
| Output tensors | Names, shapes, dtype, coordinate convention, confidence/objectness semantics |
| Class mapping | Index-to-label table mapped into CREBAIN `DetectionClass` values |
| Postprocessing | NMS, score thresholding, coordinate scaling, and max detections behavior |
| Validation data | Fixture images or frames used to verify expected detections |
| Benchmark context | Hardware, OS, backend, model file, thresholds, and command used |

## Backend-Specific Expectations

| Backend | Contract Notes |
|---------|----------------|
| Browser ONNX (`YOLODetector`, `RFDETRDetector`, `CoreMLDetector`) | Validate ONNX Runtime Web execution providers, tensor names, preprocessing, and whether output tensors are raw or post-processed. |
| Native CoreML | Use `.mlmodelc` directories through the Rust/Tauri backend. Confirm Vision/CoreML input handling, class labels, and coordinate conversion before trusting detections. |
| ONNX Runtime Native | Validate `CREBAIN_ONNX_MODEL` or `CREBAIN_MODEL_PATH`, expected `.onnx` extension, execution provider availability, and structured failure payloads. |
| CUDA / TensorRT | Treat acceleration choice as deployment-dependent. Record hardware, driver/runtime versions, engine cache settings, and benchmark command before making performance claims. |
| MLX | Experimental opt-in scaffold until a real YOLOv8 forward pass, tensor decoding, and tests are implemented. Do not use scaffold output as evidence of detection capability. |
| Moondream | Vision-language prompts and parsed text output are heuristic. Treat bounding boxes and confidence as approximate unless validated against fixtures. |

## Minimum Acceptance Before Trusting Detections

1. Model path validation succeeds without traversal, null bytes, or unexpected extension.
2. At least one fixture frame produces the expected class labels and bounding boxes within documented tolerance.
3. Empty/no-target frames do not produce systematic false positives under the chosen thresholds.
4. Confidence thresholding and max-detection limits behave consistently across frontend/backend paths used by the scenario.
5. Any benchmark result includes target hardware, model file, backend, command, and threshold settings.
