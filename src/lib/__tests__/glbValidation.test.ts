import { describe, expect, it } from 'vitest'
import { validateSelfContainedGlb } from '../glbValidation'

function makeGlb(
  manifest: Record<string, unknown>,
  binary: Uint8Array = new Uint8Array()
): ArrayBuffer {
  const encodedJson = new TextEncoder().encode(JSON.stringify(manifest))
  const paddedJsonLength = Math.ceil(encodedJson.length / 4) * 4
  const binaryLength = Math.ceil(binary.length / 4) * 4
  const totalLength = 12 + 8 + paddedJsonLength + (binaryLength > 0 ? 8 + binaryLength : 0)
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  view.setUint32(12, paddedJsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  output.fill(0x20, 20, 20 + paddedJsonLength)
  output.set(encodedJson, 20)
  if (binaryLength > 0) {
    const chunkOffset = 20 + paddedJsonLength
    view.setUint32(chunkOffset, binaryLength, true)
    view.setUint32(chunkOffset + 4, 0x004e4942, true)
    output.set(binary, chunkOffset + 8)
  }
  return output.buffer
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

describe('validateSelfContainedGlb', () => {
  it('accepts an embedded binary PNG within the texture budget', () => {
    const png = pngHeader(32, 16)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: png.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
      },
      png
    )

    expect(() => validateSelfContainedGlb(glb)).not.toThrow()
  })

  it('rejects external buffers and image resources', () => {
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 1 }] })
      )
    ).toThrow('external resource')
    expect(() =>
      validateSelfContainedGlb(
        makeGlb({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/a.png' }] })
      )
    ).toThrow('external resource')
  })

  it('rejects texture decompression bombs before GLTFLoader parses them', () => {
    const png = pngHeader(8192, 8192)
    const glb = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: png.length }],
        bufferViews: [{ buffer: 0, byteLength: png.length }],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
      },
      png
    )
    expect(() => validateSelfContainedGlb(glb)).toThrow('aggregate pixels')
  })

  it('rejects malformed headers and declared lengths', () => {
    const glb = makeGlb({ asset: { version: '2.0' } })
    new DataView(glb).setUint32(8, glb.byteLength + 4, true)
    expect(() => validateSelfContainedGlb(glb)).toThrow('declared length')
    expect(() => validateSelfContainedGlb(new ArrayBuffer(4))).toThrow('too short')
  })
})
