# CREBAIN Detection Models

This directory is for local development model files. Model weights are not committed to the repository.

## YOLO (Default)

- `yolov8n.onnx` - YOLOv8 Nano (~6MB, fastest)
- `yolov8s.onnx` - YOLOv8 Small (~22MB, balanced)

## RF-DETR (Transformer-based)

- `rf-detr.onnx` - RF-DETR detection transformer
- Export from PaddleDetection using `paddle2onnx`
- No NMS required (model outputs post-processed detections)

## Moondream (Vision-Language Model)

- Uses `@xenova/transformers` with Hugging Face model
- Model ID: `Xenova/moondream2` (auto-downloaded)
- `@xenova/transformers` is already declared in `package.json`
- Zero-shot detection via natural language prompting

## CoreML (Apple Vision Models)

- `coreml-detector.onnx` - Converted CoreML model
- Convert using Apple's `coremltools`:

  ```python
  import coremltools as ct
  model = ct.models.MLModel('model.mlmodel')
  model.save('model.onnx')
  ```

- Supports Vision framework preprocessing modes

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
