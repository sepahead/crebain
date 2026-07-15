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

## Operator-supplied GLB resource contract

The 3D viewer accepts a deliberately narrow, self-contained GLB 2.0 profile.
Before `GLTFLoader` sees the bytes, CREBAIN validates the single JSON/optional
BIN container, rejects external resources and duplicate JSON keys, verifies all
buffer-view spans, and applies glTF component/type/stride rules to every
accessor. Accessor count, packed/interleaved spans, and sparse index/value spans
must be internally consistent. The aggregate decoded accessor working set is
bounded to 256 MiB independently of compressed/source size; this prevents a tiny
manifest from declaring loader-scale geometry amplification.
Draco, meshopt, GPU-instancing, punctual-light, and texture-transform
extensions are outside this bounded profile because their derived
allocation/render expansion is not represented by the ordinary accessor and
node spans alone. Material texture references must use texture coordinate set
zero so `GLTFLoader` does not clone textures into uncounted GPU identities.
Primitive modes 0-4 are accepted; triangle-strip and triangle-fan modes are
rejected because `GLTFLoader` expands their indices before rendering.

Structural preflight also enforces these loader-work ceilings before parsing:

| Structure | Maximum accepted work |
|-----------|-----------------------|
| Scene graph | 4,096 nodes, depth 128, 64 scenes, 256 roots per scene, 1,024 root references, and 16,384 aggregate subtree visits |
| Geometry | 2,048 meshes, 256 primitives per mesh, 8,192 primitive definitions, 2,048 node-instantiated primitives, 65,536 primitive-to-accessor references, and 67,108,864 instantiated draw elements |
| Morphing | 64 FLOAT VEC3 targets per primitive, 16,384 aggregate target references, 256 MiB expanded Float32 RGBA texture storage, and 67,108,864 instantiated vertex/target work units |
| Presentation resources | 2,048 materials, 2,048 textures, 256 validated texture samplers, 16 loader cache identities (sampler indices, including undefined) per image, 256 embedded images, and 256 cameras |
| Skinning | 256 skins, 512 joints per skin, and 8,192 aggregate joint references |
| Animation | 256 animations, 1,024 samplers and channels per animation, 4,096 of each in aggregate, 8,192 derived tracks, 1,048,576 referenced keyframes, and 16,777,216 aggregate input/output work components |
| Cloneable metadata | 512 KiB per node, mesh, camera, material, or image definition and 16 MiB after scene/node/primitive/material-variant/texture-identity clone multiplicity |

Node children must form disjoint strict trees: cycles, repeated children, and
multiple parents are rejected. Scene entries must reference roots. Every node,
mesh primitive, material texture, skin, scene, and animation index is checked.
Legal reuse is charged each time it expands loader work, including a mesh reused
by many nodes, an image used with distinct sampler indices, a hierarchy reused
by many scenes, or one animation sampler reused by many channels. Animation
output shape/count is checked against target path, interpolation, keyframes, and
morph-target cardinality. Mesh extras are charged once per primitive object and
again across node clones; camera metadata is charged across camera-node clones;
material metadata uses a conservative bound over base, Points/Line, and
geometry-feature variants.

The same decoded-accessor, decoded/resident-texture, node, primitive, draw,
morph, graph, animation, and cloneable-metadata ceilings apply to all loaded and
concurrently parsing GLBs in aggregate. Validation summaries are reserved
synchronously before `GLTFLoader.parse`, retained with accepted assets, and
released when each parse actually settles. A generation reset or unmount fences
stale results but does not prematurely release a callback-only parse's
reservation; removing/resetting an accepted asset releases its retained
summary. Source bytes remain independently bounded to 128 MiB per GLB and 512
MiB per scene. Remote GLBs reserve the full per-source ceiling before fetch and
atomically shrink that reservation to the received length.

Embedded PNG/JPEG resources undergo bounded structural/dimension preflight.
Identical encoded buffer spans are inspected once, while every declared image
still consumes its own decoded aggregate pixel budget. Distinct embedded-image
buffer views cannot overlap, preventing nested spans from multiplying CRC scan
work. Each unique
image/loader-sampler-identity pair also consumes the same aggregate
resident-pixel budget and image metadata multiplier, preventing equal sampler
definitions at different indices from multiplying GPU texture residency. These
checks are resource ceilings and parser hardening, not proof that an
operator-supplied asset is safe, accurate, licensed, or suitable for deployment.

## Backend-specific expectations

| Backend | Contract notes |
|---------|----------------|
| Native CoreML | Use a validated `.mlmodelc` directory. Confirm Vision/CoreML input handling, model labels, coordinate conversion, and fixture results. |
| ONNX Runtime Native | Validate `CREBAIN_ONNX_MODEL` or `CREBAIN_MODEL_PATH`, the `.onnx` extension, execution provider, 84-feature COCO contract, and structured failure path. |
| CUDA / TensorRT | Record hardware, driver/runtime versions, cache settings, ONNX input, engine output, and benchmark command. INT8 engine building needs calibration data and is not supported by the current build command. |
| MLX | Experimental opt-in path. `CREBAIN_MLX_MODEL` must be a validated `.safetensors` file; `CREBAIN_MLX_MODEL_SHA256` may pin its digest. No release evidence without artifact provenance, tensor/class fixtures, and target-hardware benchmarks. |

## Minimum acceptance before trusting detections

1. Path validation rejects traversal, null bytes, missing paths, final symlinks,
   special files, directories for regular-file formats, and unexpected
   extensions. A compiled `.mlmodelc` must be a real directory.
2. The exact input and output shapes match the selected implementation before postprocessing.
3. Golden target frames produce expected labels and boxes within a documented tolerance.
4. Empty/no-target frames do not produce systematic false positives at the chosen thresholds.
5. Threshold and maximum-detection behavior agree across every runtime path used by the scenario.
6. Benchmarks record hardware, model digest, backend, invocation, thresholds, and fixture inputs.

Native runtimes reopen a validated path. Keep the model and parent directories
immutable and access-controlled throughout loading; this release does not claim
protection against a concurrent privileged local path replacement. Digest-pin
the exact artifact where supported and record the loaded artifact identity.

## Native latency artifact

The release-command harness in
[NATIVE_DETECTOR_BENCHMARK.md](NATIVE_DETECTOR_BENCHMARK.md) records
content-identified model/fixture inputs, raw sequential detector-call samples,
policy, provider label, and an operator-declared target profile. That artifact
supplies latency context only. It does not establish provenance or rights,
validate tensor/class mapping, compare detections with golden truth, measure
false positives, attest accelerator graph placement, or prove end-to-end camera
throughput. Those model-contract gates remain required independently.
