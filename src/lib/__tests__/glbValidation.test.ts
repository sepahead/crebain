import { describe, expect, it } from 'vitest'
import {
  MAX_GLB_ACCESSOR_ELEMENTS,
  MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION,
  MAX_GLB_ANIMATION_KEYFRAMES,
  MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT,
  MAX_GLB_GRAPH_VISITS,
  MAX_GLB_INSTANTIATED_DRAW_ELEMENTS,
  MAX_GLB_INSTANTIATED_MORPH_WORK,
  MAX_GLB_MORPH_TEXTURE_BYTES,
  MAX_GLB_METADATA_CLONE_BYTES,
  MAX_GLB_NODE_HIERARCHY_DEPTH,
  MAX_GLB_NODES,
  MAX_GLB_PRIMITIVE_INSTANCES,
  MAX_GLB_PRIMITIVES_PER_MESH,
  MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE,
  validateSelfContainedGlb,
} from '../glbValidation'

const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

interface GlbChunk {
  type: number
  bytes: Uint8Array
  paddingByte?: number
}

function encodeJson(json: string): GlbChunk {
  return { type: JSON_CHUNK_TYPE, bytes: new TextEncoder().encode(json), paddingByte: 0x20 }
}

function encodeManifest(manifest: unknown): GlbChunk {
  return encodeJson(JSON.stringify(manifest))
}

function encodeBin(bytes: Uint8Array = new Uint8Array()): GlbChunk {
  return { type: BIN_CHUNK_TYPE, bytes }
}

function makeGlbFromChunks(chunks: GlbChunk[]): ArrayBuffer {
  const chunkLengths = chunks.map((chunk) => Math.ceil(chunk.bytes.length / 4) * 4)
  const totalLength = 12 + chunkLengths.reduce((total, length) => total + 8 + length, 0)
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)

  let offset = 12
  chunks.forEach((chunk, index) => {
    const paddedLength = chunkLengths[index]
    view.setUint32(offset, paddedLength, true)
    view.setUint32(offset + 4, chunk.type, true)
    output.fill(chunk.paddingByte ?? 0, offset + 8, offset + 8 + paddedLength)
    output.set(chunk.bytes, offset + 8)
    offset += 8 + paddedLength
  })
  return output.buffer
}

function makeGlb(
  manifest: Record<string, unknown>,
  binary: Uint8Array = new Uint8Array()
): ArrayBuffer {
  const chunks = [encodeManifest(manifest)]
  if (binary.length > 0) chunks.push(encodeBin(binary))
  return makeGlbFromChunks(chunks)
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngWithDimensions(width: number, height: number): Uint8Array {
  const binary = atob(PNG_1X1_BASE64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  view.setUint32(29, crc32(bytes, 12, 29), false)
  return bytes
}

function manifestWithEmbeddedPng(png: Uint8Array): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: png.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
  }
}

function manifestWithOnePositionAccessor(count = 1): {
  binary: Uint8Array
  manifest: Record<string, unknown>
} {
  const binary = new Uint8Array(count * 12)
  return {
    binary,
    manifest: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count, type: 'VEC3' }],
    },
  }
}

function manifestWithRepeatedAnimationSampler(
  keyframeCount: number,
  channelCount: number
): { binary: Uint8Array; manifest: Record<string, unknown> } {
  const inputBytes = keyframeCount * 4
  const outputBytes = keyframeCount * 12
  const binary = new Uint8Array(inputBytes + outputBytes)
  return {
    binary,
    manifest: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: inputBytes },
        { buffer: 0, byteOffset: inputBytes, byteLength: outputBytes },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: keyframeCount, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: keyframeCount, type: 'VEC3' },
      ],
      nodes: [{}],
      animations: [
        {
          samplers: [{ input: 0, output: 1 }],
          channels: Array.from({ length: channelCount }, () => ({
            sampler: 0,
            target: { node: 0, path: 'translation' },
          })),
        },
      ],
    },
  }
}

describe('validateSelfContainedGlb', () => {
  it('accepts an embedded PNG with valid chunk framing and CRCs', () => {
    const png = pngWithDimensions(1, 1)
    const glb = makeGlb(manifestWithEmbeddedPng(png), png)

    expect(() => validateSelfContainedGlb(glb)).not.toThrow()
  })

  it('rejects an external buffer', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      buffers: [{ uri: 'mesh.bin', byteLength: 1 }],
    })

    expect(() => validateSelfContainedGlb(glb)).toThrow('external resource')
  })

  it('rejects an external image', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      images: [{ uri: 'https://example.com/a.png' }],
    })

    expect(() => validateSelfContainedGlb(glb)).toThrow('external resource')
  })

  it('accepts the canonical embedded raster data URI admitted by the production loader', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      images: [{ uri: `data:image/png;base64,${PNG_1X1_BASE64}` }],
    })

    expect(() => validateSelfContainedGlb(glb)).not.toThrow()
  })

  it.each([
    ['non-string', 7],
    ['non-image data', 'data:application/octet-stream;base64,AA=='],
    ['empty raster data', 'data:image/png;base64,'],
    ['non-canonical base64', 'data:image/png;base64,%%%%'],
    ['non-canonical JPEG MIME alias', `data:image/jpg;base64,${PNG_1X1_BASE64}`],
    ['uppercase scheme', `DATA:image/png;base64,${PNG_1X1_BASE64}`],
  ])('rejects a %s URI before production parsing', (_name, uri) => {
    const glb = makeGlb({ asset: { version: '2.0' }, images: [{ uri }] })

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      'external resource or a non-canonical embedded resource'
    )
  })

  it('iteratively rejects an external URI at the maximum supported nesting scale', () => {
    let nested: Record<string, unknown> = { uri: 'https://example.com/deep.png' }
    for (let depth = 0; depth < 120; depth += 1) nested = { extras: nested }
    const glb = makeGlb({ asset: { version: '2.0' }, extras: nested })

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      'external resource or a non-canonical embedded resource'
    )
  })

  it('rejects a wide manifest array before admitting it to the URI work stack', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      extras: new Array(262_145).fill(null),
    })

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      'resource URI scan exceeds its bounded work limit'
    )
  })

  it('rejects an image with ambiguous URI and bufferView sources', () => {
    const png = pngWithDimensions(1, 1)
    const glb = makeGlb(
      {
        ...manifestWithEmbeddedPng(png),
        images: [
          {
            uri: `data:image/png;base64,${PNG_1X1_BASE64}`,
            bufferView: 0,
            mimeType: 'image/png',
          },
        ],
      },
      png
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('both uri and bufferView')
  })

  it('rejects oversized declared texture dimensions before GLTFLoader parses them', () => {
    const png = pngWithDimensions(8192, 8192)
    const glb = makeGlb(manifestWithEmbeddedPng(png), png)

    expect(() => validateSelfContainedGlb(glb)).toThrow('aggregate pixels')
  })

  it('rejects a signature-only PNG dimension header', () => {
    const fakePng = new Uint8Array(24)
    fakePng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(fakePng.buffer)
    view.setUint32(16, 1, false)
    view.setUint32(20, 1, false)
    const glb = makeGlb(manifestWithEmbeddedPng(fakePng), fakePng)

    expect(() => validateSelfContainedGlb(glb)).toThrow('dimension preflight')
  })

  it('rejects a PNG with a bad chunk CRC', () => {
    const png = pngWithDimensions(1, 1)
    png[29] ^= 0xff
    const glb = makeGlb(manifestWithEmbeddedPng(png), png)

    expect(() => validateSelfContainedGlb(glb)).toThrow('dimension preflight')
  })

  it('rejects duplicate JSON chunks', () => {
    const glb = makeGlbFromChunks([
      encodeManifest({ asset: { version: '2.0' } }),
      encodeManifest({ asset: { version: '2.0' } }),
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('exactly one JSON chunk')
  })

  it('rejects an external resource hidden in a second JSON manifest', () => {
    const glb = makeGlbFromChunks([
      encodeManifest({ asset: { version: '2.0' } }),
      encodeManifest({
        asset: { version: '2.0' },
        images: [{ uri: 'https://attacker.example/pixel.png' }],
      }),
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('exactly one JSON chunk')
  })

  it('rejects duplicate BIN chunks', () => {
    const glb = makeGlbFromChunks([
      encodeManifest({ asset: { version: '2.0' } }),
      encodeBin(new Uint8Array([1])),
      encodeBin(new Uint8Array([2])),
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('one BIN chunk')
  })

  it('rejects additional unknown chunks outside the canonical JSON/BIN profile', () => {
    const glb = makeGlbFromChunks([
      encodeManifest({ asset: { version: '2.0' } }),
      { type: 0x12345678, bytes: new Uint8Array([1, 2, 3, 4]) },
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('unsupported chunk type')
  })

  it('rejects a BIN chunk before the JSON chunk', () => {
    const glb = makeGlbFromChunks([
      encodeBin(new Uint8Array([1])),
      encodeManifest({ asset: { version: '2.0' } }),
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('JSON chunk must be the first')
  })

  it('rejects an array manifest root', () => {
    const glb = makeGlbFromChunks([encodeJson('[]')])

    expect(() => validateSelfContainedGlb(glb)).toThrow('manifest must be an object')
  })

  it('rejects duplicate object keys including escaped aliases', () => {
    const glb = makeGlbFromChunks([
      encodeJson('{"asset":{"version":"2.0"},"\\u0061sset":{"version":"2.0"}}'),
    ])

    expect(() => validateSelfContainedGlb(glb)).toThrow('duplicate object key')
  })

  it('rejects a misaligned chunk length', () => {
    const glb = makeGlb({ asset: { version: '2.0' } })
    new DataView(glb).setUint32(12, 3, true)

    expect(() => validateSelfContainedGlb(glb)).toThrow('chunk length must be 4-byte aligned')
  })

  it('rejects malformed headers and declared lengths', () => {
    const glb = makeGlb({ asset: { version: '2.0' } })
    new DataView(glb).setUint32(8, glb.byteLength + 4, true)

    expect(() => validateSelfContainedGlb(glb)).toThrow('declared length')
    expect(() => validateSelfContainedGlb(new ArrayBuffer(4))).toThrow('too short')
  })

  it('rejects tiny manifests that declare amplified decoded accessor geometry', () => {
    const binary = new Uint8Array(4)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5126,
            count: MAX_GLB_ACCESSOR_ELEMENTS,
            type: 'MAT4',
          },
        ],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('decoded accessors exceed')
  })

  it.each(['EXT_meshopt_compression', 'KHR_draco_mesh_compression', 'EXT_mesh_gpu_instancing'])(
    'rejects source-independent geometry amplification through %s',
    (extension) => {
      const glb = makeGlb({
        asset: { version: '2.0' },
        nodes: [{ extensions: { [extension]: { count: MAX_GLB_ACCESSOR_ELEMENTS } } }],
      })

      expect(() => validateSelfContainedGlb(glb)).toThrow('outside the bounded loader profile')
    }
  )

  it('validates packed accessor spans before GLTFLoader allocation', () => {
    const binary = new Uint8Array(12)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('accessor 0 exceeds its bufferView')
  })

  it('validates sparse accessor counts and packed index/value spans', () => {
    const binary = new Uint8Array(8)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 4 },
          { buffer: 0, byteOffset: 4, byteLength: 4 },
        ],
        accessors: [
          {
            componentType: 5126,
            count: 2,
            type: 'SCALAR',
            sparse: {
              count: 2,
              indices: { bufferView: 0, componentType: 5125 },
              values: { bufferView: 1 },
            },
          },
        ],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('sparse indices exceeds its bufferView')
  })

  it('rejects sparse indices that are not strictly increasing', () => {
    const binary = new Uint8Array(12)
    binary.set([2, 1], 0)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 2 },
          { buffer: 0, byteOffset: 4, byteLength: 8 },
        ],
        accessors: [
          {
            componentType: 5126,
            count: 3,
            type: 'SCALAR',
            sparse: {
              count: 2,
              indices: { bufferView: 0, componentType: 5121 },
              values: { bufferView: 1 },
            },
          },
        ],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('strictly increasing')
  })

  it('accepts the exact node ceiling and rejects a tiny manifest with one more empty node', () => {
    const exact = makeGlb({
      asset: { version: '2.0' },
      nodes: Array.from({ length: MAX_GLB_NODES }, () => ({})),
    })
    const oversized = makeGlb({
      asset: { version: '2.0' },
      nodes: Array.from({ length: MAX_GLB_NODES + 1 }, () => ({})),
    })

    expect(validateSelfContainedGlb(exact)).toMatchObject({ nodes: MAX_GLB_NODES })
    expect(() => validateSelfContainedGlb(oversized)).toThrow(`at most ${MAX_GLB_NODES} nodes`)
  })

  it('rejects cycles, multiple parents, invalid indices, and non-root scene references', () => {
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({ asset: { version: '2.0' }, nodes: [{ children: [1] }, { children: [0] }] })
      )
    ).toThrow('contains a cycle')
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({
          asset: { version: '2.0' },
          nodes: [{ children: [2] }, { children: [2] }, {}],
        })
      )
    ).toThrow('multiple parents')
    expect(() =>
      validateSelfContainedGlb(makeGlb({ asset: { version: '2.0' }, nodes: [{ children: [1] }] }))
    ).toThrow('invalid index')
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({
          asset: { version: '2.0' },
          nodes: [{ children: [1] }, {}],
          scenes: [{ nodes: [1] }],
        })
      )
    ).toThrow('not a root')
  })

  it('charges repeated scene references against the aggregate graph-visit ceiling', () => {
    const sceneCopies = 8
    const subtreeSize = MAX_GLB_GRAPH_VISITS / sceneCopies
    expect(Number.isInteger(subtreeSize)).toBe(true)
    expect(subtreeSize).toBeLessThanOrEqual(MAX_GLB_NODES)
    const nodes = Array.from({ length: subtreeSize }, (_, index) =>
      index === 0
        ? { children: Array.from({ length: subtreeSize - 1 }, (_, child) => child + 1) }
        : {}
    )
    const scenes = Array.from({ length: sceneCopies }, () => ({ nodes: [0] }))

    expect(
      validateSelfContainedGlb(makeGlb({ asset: { version: '2.0' }, nodes, scenes }))
    ).toMatchObject({ graphVisits: MAX_GLB_GRAPH_VISITS })
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({ asset: { version: '2.0' }, nodes, scenes: [...scenes, { nodes: [0] }] })
      )
    ).toThrow(`exceed ${MAX_GLB_GRAPH_VISITS} aggregate graph visits`)
  })

  it('accepts the exact hierarchy-depth ceiling and rejects one deeper legal tree', () => {
    const chain = (length: number) =>
      Array.from({ length }, (_, index) => (index + 1 < length ? { children: [index + 1] } : {}))

    expect(() =>
      validateSelfContainedGlb(
        makeGlb({
          asset: { version: '2.0' },
          nodes: chain(MAX_GLB_NODE_HIERARCHY_DEPTH),
          scenes: [{ nodes: [0] }],
        })
      )
    ).not.toThrow()
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({
          asset: { version: '2.0' },
          nodes: chain(MAX_GLB_NODE_HIERARCHY_DEPTH + 1),
          scenes: [{ nodes: [0] }],
        })
      )
    ).toThrow(`maximum depth of ${MAX_GLB_NODE_HIERARCHY_DEPTH}`)
  })

  it('charges node metadata again when scenes repeat a root', () => {
    const scenes = Array.from({ length: 64 }, () => ({ nodes: [0] }))
    const payload = 'x'.repeat(Math.floor(MAX_GLB_METADATA_CLONE_BYTES / scenes.length))
    const glb = makeGlb({
      asset: { version: '2.0' },
      nodes: [{ extras: { payload } }],
      scenes,
    })

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
  })

  it('charges attached mesh metadata again when scenes repeat its node', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const scenes = Array.from({ length: 64 }, () => ({ nodes: [0] }))
    const payload = 'x'.repeat(Math.floor(MAX_GLB_METADATA_CLONE_BYTES / scenes.length))
    const glb = makeGlb(
      {
        ...manifest,
        meshes: [
          {
            extras: { payload },
            primitives: [{ attributes: { POSITION: 0 } }],
          },
        ],
        nodes: [{ mesh: 0 }],
        scenes,
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
  })

  it('charges mesh metadata for every node clone and caps each cloneable payload', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const payload = 'x'.repeat(300_000)
    const nodes = Array.from({ length: 64 }, () => ({ mesh: 0 }))
    const withMeshExtras = (extras: unknown) =>
      makeGlb(
        {
          ...manifest,
          meshes: [
            {
              extras,
              primitives: [{ attributes: { POSITION: 0 } }],
            },
          ],
          nodes,
          scenes: [{ nodes: nodes.map((_, index) => index) }],
        },
        binary
      )

    expect(() => validateSelfContainedGlb(withMeshExtras({ payload }))).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
    expect(() =>
      validateSelfContainedGlb(
        withMeshExtras({
          payload: 'x'.repeat(MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT + 1),
        })
      )
    ).toThrow(`exceeds ${MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT} cloneable metadata bytes`)
  })

  it('charges mesh extras on every primitive object before node cloning', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const primitive = { attributes: { POSITION: 0 } }
    const primitives = Array.from({ length: MAX_GLB_PRIMITIVES_PER_MESH }, () => primitive)
    const nodes = Array.from({ length: 8 }, () => ({ mesh: 0 }))
    const glb = makeGlb(
      {
        ...manifest,
        meshes: [{ extras: { payload: 'x'.repeat(70_000) }, primitives }],
        nodes,
        scenes: [{ nodes: nodes.map((_, index) => index) }],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
  })

  it('caps camera metadata and charges every camera-node clone', () => {
    const nodes = Array.from({ length: 64 }, () => ({ camera: 0 }))
    const withCameraPayload = (payload: string) =>
      makeGlb({
        asset: { version: '2.0' },
        cameras: [
          {
            type: 'perspective',
            perspective: { yfov: 1, znear: 0.1 },
            extras: { payload },
          },
        ],
        nodes,
        scenes: [{ nodes: nodes.map((_, index) => index) }],
      })

    expect(() => validateSelfContainedGlb(withCameraPayload('x'.repeat(300_000)))).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
    expect(() =>
      validateSelfContainedGlb(
        withCameraPayload('x'.repeat(MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT + 1))
      )
    ).toThrow(`exceeds ${MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT} cloneable metadata bytes`)
  })

  it('caps material metadata and charges conservative final-material variants', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const primitives = Array.from({ length: 24 }, () => ({
      attributes: { POSITION: 0 },
      material: 0,
    }))
    const glb = makeGlb(
      {
        ...manifest,
        materials: [{ extras: { payload: 'x'.repeat(300_000) } }],
        meshes: [{ primitives }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      `cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
  })

  it('accepts the exact per-mesh primitive ceiling and rejects one more primitive', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const primitive = { attributes: { POSITION: 0 } }
    const exactPrimitives = Array.from({ length: MAX_GLB_PRIMITIVES_PER_MESH }, () => primitive)

    expect(
      validateSelfContainedGlb(
        makeGlb(
          {
            ...manifest,
            meshes: [{ primitives: exactPrimitives }],
            nodes: [{ mesh: 0 }],
            scenes: [{ nodes: [0] }],
          },
          binary
        )
      )
    ).toMatchObject({ meshPrimitives: MAX_GLB_PRIMITIVES_PER_MESH })
    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            ...manifest,
            meshes: [{ primitives: [...exactPrimitives, primitive] }],
          },
          binary
        )
      )
    ).toThrow(`at most ${MAX_GLB_PRIMITIVES_PER_MESH} mesh 0 primitives`)
  })

  it.each([5, 6])('rejects loader-expanded primitive mode %i', (mode) => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const glb = makeGlb(
      {
        ...manifest,
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      'outside the bounded loader profile; triangle strips and fans are unsupported'
    )
  })

  it('charges repeated mesh references against the primitive-instance ceiling', () => {
    const { binary, manifest } = manifestWithOnePositionAccessor()
    const primitives = Array.from({ length: MAX_GLB_PRIMITIVES_PER_MESH }, () => ({
      attributes: { POSITION: 0 },
    }))
    const exactNodeCount = MAX_GLB_PRIMITIVE_INSTANCES / MAX_GLB_PRIMITIVES_PER_MESH
    expect(Number.isInteger(exactNodeCount)).toBe(true)
    const exactNodes = Array.from({ length: exactNodeCount }, () => ({ mesh: 0 }))
    const base = { ...manifest, meshes: [{ primitives }] }

    expect(validateSelfContainedGlb(makeGlb({ ...base, nodes: exactNodes }, binary))).toMatchObject(
      {
        primitiveInstances: MAX_GLB_PRIMITIVE_INSTANCES,
      }
    )
    expect(() =>
      validateSelfContainedGlb(makeGlb({ ...base, nodes: [...exactNodes, { mesh: 0 }] }, binary))
    ).toThrow(`exceed ${MAX_GLB_PRIMITIVE_INSTANCES} aggregate primitive instances`)
  })

  it('charges draw elements again for every node that instantiates a mesh', () => {
    const instanceCount = MAX_GLB_PRIMITIVE_INSTANCES
    const elementsPerInstance = MAX_GLB_INSTANTIATED_DRAW_ELEMENTS / instanceCount
    expect(Number.isInteger(elementsPerInstance)).toBe(true)
    const exact = manifestWithOnePositionAccessor(elementsPerInstance)
    const oversized = manifestWithOnePositionAccessor(elementsPerInstance + 1)
    const nodes = Array.from({ length: instanceCount }, (_, index) =>
      index === 0
        ? { mesh: 0, children: Array.from({ length: instanceCount - 1 }, (_, child) => child + 1) }
        : { mesh: 0 }
    )
    const withMeshAndScene = (manifest: Record<string, unknown>) => ({
      ...manifest,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes,
      scenes: [{ nodes: [0] }],
    })

    expect(
      validateSelfContainedGlb(makeGlb(withMeshAndScene(exact.manifest), exact.binary))
    ).toMatchObject({ instantiatedDrawElements: MAX_GLB_INSTANTIATED_DRAW_ELEMENTS })
    expect(() =>
      validateSelfContainedGlb(makeGlb(withMeshAndScene(oversized.manifest), oversized.binary))
    ).toThrow(`exceed ${MAX_GLB_INSTANTIATED_DRAW_ELEMENTS} aggregate instantiated draw elements`)
  })

  it('charges per-vertex morph shader work for every mesh instance', () => {
    const targetCount = 4
    const instanceCount = MAX_GLB_PRIMITIVE_INSTANCES
    const elementsPerInstance = MAX_GLB_INSTANTIATED_MORPH_WORK / (instanceCount * targetCount)
    expect(Number.isInteger(elementsPerInstance)).toBe(true)
    const exact = manifestWithOnePositionAccessor(elementsPerInstance)
    const oversized = manifestWithOnePositionAccessor(elementsPerInstance + 1)
    const targets = Array.from({ length: targetCount }, () => ({ POSITION: 0 }))
    const nodes = Array.from({ length: instanceCount }, (_, index) =>
      index === 0
        ? { mesh: 0, children: Array.from({ length: instanceCount - 1 }, (_, child) => child + 1) }
        : { mesh: 0 }
    )
    const withMorphInstances = (manifest: Record<string, unknown>) => ({
      ...manifest,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets }] }],
      nodes,
      scenes: [{ nodes: [0] }],
    })

    expect(
      validateSelfContainedGlb(makeGlb(withMorphInstances(exact.manifest), exact.binary))
    ).toMatchObject({ instantiatedMorphWork: MAX_GLB_INSTANTIATED_MORPH_WORK })
    expect(() =>
      validateSelfContainedGlb(makeGlb(withMorphInstances(oversized.manifest), oversized.binary))
    ).toThrow(`exceed ${MAX_GLB_INSTANTIATED_MORPH_WORK} aggregate instantiated morph work`)
  })

  it('caps expanded Float32 RGBA morph texture storage independently of source bytes', () => {
    const targetCount = 64
    const exactVertexCount = MAX_GLB_MORPH_TEXTURE_BYTES / (targetCount * 16)
    expect(Number.isInteger(exactVertexCount)).toBe(true)
    const exact = manifestWithOnePositionAccessor(exactVertexCount)
    const oversized = manifestWithOnePositionAccessor(exactVertexCount + 1)
    const targets = Array.from({ length: targetCount }, () => ({ POSITION: 0 }))
    const withMorphTargets = (manifest: Record<string, unknown>) => ({
      ...manifest,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    })

    expect(
      validateSelfContainedGlb(makeGlb(withMorphTargets(exact.manifest), exact.binary))
    ).toMatchObject({ morphTextureBytes: MAX_GLB_MORPH_TEXTURE_BYTES })
    expect(() =>
      validateSelfContainedGlb(makeGlb(withMorphTargets(oversized.manifest), oversized.binary))
    ).toThrow(`exceed ${MAX_GLB_MORPH_TEXTURE_BYTES} expanded texture bytes`)
  })

  it('requires morph attributes to use the bounded FLOAT VEC3 profile', () => {
    const binary = new Uint8Array(3)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: binary.length }],
        bufferViews: [{ buffer: 0, byteLength: binary.length }],
        accessors: [
          {
            bufferView: 0,
            componentType: 5120,
            count: 1,
            normalized: true,
            type: 'VEC3',
          },
        ],
        meshes: [
          {
            primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }],
          },
        ],
        nodes: [{ mesh: 0 }],
      },
      binary
    )

    expect(() => validateSelfContainedGlb(glb)).toThrow('must use a FLOAT VEC3 accessor')
  })

  it('charges every channel that repeats an animation sampler against keyframe work', () => {
    const keyframesPerChannel =
      MAX_GLB_ANIMATION_KEYFRAMES / MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION
    expect(Number.isInteger(keyframesPerChannel)).toBe(true)
    const exact = manifestWithRepeatedAnimationSampler(
      keyframesPerChannel,
      MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION
    )
    const oversized = manifestWithRepeatedAnimationSampler(
      keyframesPerChannel + 1,
      MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION
    )

    expect(validateSelfContainedGlb(makeGlb(exact.manifest, exact.binary))).toMatchObject({
      animationChannels: MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION,
      animationKeyframes: MAX_GLB_ANIMATION_KEYFRAMES,
    })
    expect(() => validateSelfContainedGlb(makeGlb(oversized.manifest, oversized.binary))).toThrow(
      `exceed ${MAX_GLB_ANIMATION_KEYFRAMES} aggregate referenced keyframes`
    )
  })

  it('rejects an animation with more than the per-animation channel ceiling', () => {
    const oversized = manifestWithRepeatedAnimationSampler(
      1,
      MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION + 1
    )

    expect(() => validateSelfContainedGlb(makeGlb(oversized.manifest, oversized.binary))).toThrow(
      `at most ${MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION} animation 0 channels`
    )
  })

  it('charges unique sampler-index identities as resident texture pixels', () => {
    const png = pngWithDimensions(1, 1)
    const base = manifestWithEmbeddedPng(png)
    const samplers = [{ magFilter: 9728 }, { magFilter: 9729 }]
    const exact = { ...base, samplers, textures: [{ source: 0, sampler: 0 }] }
    const amplified = {
      ...base,
      samplers,
      textures: [
        { source: 0, sampler: 0 },
        { source: 0, sampler: 1 },
      ],
    }

    expect(validateSelfContainedGlb(makeGlb(exact, png), 1)).toMatchObject({
      decodedTexturePixels: 1,
      residentTexturePixels: 1,
    })
    expect(() => validateSelfContainedGlb(makeGlb(amplified, png), 1)).toThrow(
      'resident texture variants exceed 1 aggregate pixels'
    )
  })

  it('caps loader texture identities per image and validates sampler enums', () => {
    const png = pngWithDimensions(1, 1)
    const base = manifestWithEmbeddedPng(png)
    const samplers = Array.from({ length: MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE + 1 }, (_, index) => ({
      magFilter: [9728, 9729][index % 2],
      minFilter: [9728, 9729, 9984, 9985, 9986, 9987][Math.floor(index / 2) % 6],
      wrapS: [33071, 33648, 10497][Math.floor(index / 12) % 3],
    }))
    const textures = samplers.map((_, sampler) => ({ source: 0, sampler }))

    expect(() => validateSelfContainedGlb(makeGlb({ ...base, samplers, textures }, png))).toThrow(
      `exceeds ${MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE} loader texture identities`
    )
    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            ...base,
            samplers: [{ magFilter: 1234 }],
            textures: [{ source: 0, sampler: 0 }],
          },
          png
        )
      )
    ).toThrow('magFilter is unsupported')
  })

  it('counts sampler indices as distinct loader texture identities', () => {
    const png = pngWithDimensions(1, 1)
    const base = manifestWithEmbeddedPng(png)
    const samplers = Array.from({ length: MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE + 1 }, () => ({}))
    const textures = samplers.map((_, sampler) => ({ source: 0, sampler }))

    expect(() => validateSelfContainedGlb(makeGlb({ ...base, samplers, textures }, png))).toThrow(
      `exceeds ${MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE} loader texture identities`
    )
  })

  it('caps image metadata and charges every loader texture identity clone', () => {
    const png = pngWithDimensions(1, 1)
    const imageCount = 3
    const binary = new Uint8Array(png.length * imageCount)
    for (let index = 0; index < imageCount; index += 1) binary.set(png, index * png.length)
    const bufferViews = Array.from({ length: imageCount }, (_, index) => ({
      buffer: 0,
      byteOffset: index * png.length,
      byteLength: png.length,
    }))
    const images = bufferViews.map((_, bufferView) => ({
      bufferView,
      mimeType: 'image/png',
      extras: { payload: 'x'.repeat(400_000) },
    }))
    const samplers = Array.from({ length: MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE }, () => ({}))
    const textures = images.flatMap((_, source) =>
      samplers.map((__, sampler) => ({ source, sampler }))
    )

    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            asset: { version: '2.0' },
            buffers: [{ byteLength: binary.length }],
            bufferViews,
            images,
            samplers,
            textures,
          },
          binary
        )
      )
    ).toThrow(`cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`)

    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            ...manifestWithEmbeddedPng(png),
            images: [
              {
                bufferView: 0,
                mimeType: 'image/png',
                extras: {
                  payload: 'x'.repeat(MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT + 1),
                },
              },
            ],
          },
          png
        )
      )
    ).toThrow(`exceeds ${MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT} cloneable metadata bytes`)
  })

  it('rejects texture-coordinate and transform cloning outside the bounded profile', () => {
    const png = pngWithDimensions(1, 1)
    const base = manifestWithEmbeddedPng(png)

    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            ...base,
            textures: [{ source: 0 }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } }],
          },
          png
        )
      )
    ).toThrow('texCoord must be 0 in the bounded loader profile')

    expect(() =>
      validateSelfContainedGlb(
        makeGlb(
          {
            ...base,
            textures: [{ source: 0 }],
            materials: [
              {
                pbrMetallicRoughness: {
                  baseColorTexture: {
                    index: 0,
                    extensions: { KHR_texture_transform: { offset: [0.5, 0.5] } },
                  },
                },
              },
            ],
          },
          png
        )
      )
    ).toThrow('extension KHR_texture_transform is outside the bounded loader profile')
  })

  it('rejects punctual-light cloning outside the bounded import profile', () => {
    const glb = makeGlb({
      asset: { version: '2.0' },
      extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
      nodes: [{ extensions: { KHR_lights_punctual: { light: 0 } } }],
      scenes: [{ nodes: [0] }],
    })

    expect(() => validateSelfContainedGlb(glb)).toThrow(
      'extension KHR_lights_punctual is outside the bounded loader profile'
    )
  })

  it('preflights an exact repeated image span once but charges every decoded image', () => {
    const png = pngWithDimensions(1, 1)
    const manifest = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: png.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: png.length },
        { buffer: 0, byteOffset: 0, byteLength: png.length },
      ],
      images: [
        { bufferView: 0, mimeType: 'image/png' },
        { bufferView: 1, mimeType: 'image/png' },
      ],
    }
    const glb = makeGlb(manifest, png)

    expect(validateSelfContainedGlb(glb)).toMatchObject({
      decodedTexturePixels: 2,
      referencedImages: 2,
      inspectedImageSpans: 1,
    })
    expect(() => validateSelfContainedGlb(glb, 1)).toThrow('aggregate pixels')
  })

  it('rejects distinct overlapping embedded image spans before repeated CRC work', () => {
    const png = pngWithDimensions(1, 1)
    const manifest = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: png.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: png.length },
        { buffer: 0, byteOffset: 1, byteLength: png.length - 1 },
      ],
      images: [
        { bufferView: 0, mimeType: 'image/png' },
        { bufferView: 1, mimeType: 'image/png' },
      ],
    }

    expect(() => validateSelfContainedGlb(makeGlb(manifest, png))).toThrow(
      'may be exact aliases but cannot otherwise overlap'
    )
  })
})
