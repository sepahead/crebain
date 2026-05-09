# CREBAIN Detection Models

This directory is for local development model files. Model weights are not committed to the repository.

For the required model validation record, backend-specific assumptions, and minimum acceptance criteria, see [`../../docs/MODEL_CONTRACTS.md`](../../docs/MODEL_CONTRACTS.md).

## YOLO (Default)

- `yolov8n.onnx` - Default browser ONNX path used by `YOLODetector`
- `yolov8s.onnx` - Optional larger YOLOv8-family ONNX model for local experiments

## RF-DETR (Transformer-based)

- `rf-detr.onnx` - Optional RF-DETR-family ONNX path used by `RFDETRDetector`
- Export steps and output layouts vary by model release. Confirm input shape, normalization, class mapping, and whether outputs are already post-processed before using the model in benchmarks or demos.

## Moondream (Vision-Language Model)

- Uses `@xenova/transformers` with Hugging Face model
- Model ID: `Xenova/moondream2` (auto-downloaded)
- `@xenova/transformers` is already declared in `package.json`
- Zero-shot detection via natural language prompting

## CoreML / ONNX Compatibility Path

- `coreml-detector.onnx` - Browser-side compatibility model path used by `CoreMLDetector`
- Native macOS CoreML models use `.mlmodelc` directories through the Rust/Tauri backend, not this public web-model folder.
- ONNX export/conversion steps are model-specific. Validate input names, output names, preprocessing, class mapping, and NMS behavior before trusting detections.

## Model Configuration

In `DetectorConfig`:

```ts
{
  modelPath: '/models/yolov8n.onnx',
  confidenceThreshold: 0.25,
  iouThreshold: 0.45,
  maxDetections: 100,
  useWebGPU: true
}
```
