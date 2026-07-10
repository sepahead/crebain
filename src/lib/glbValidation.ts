const GLB_MAGIC = 0x46546c67
const GLB_VERSION = 2
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942
const MAX_EMBEDDED_IMAGES = 256
const MAX_IMAGE_DIMENSION = 8192
export const MAX_GLB_TEXTURE_PIXELS = 16_777_216

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function inspectPng(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  )
    return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return [view.getUint32(16, false), view.getUint32(20, false)]
}

function inspectJpeg(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) break
    const marker = bytes[offset++]
    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker === 0xda) break
    if (offset + 2 > bytes.length) break
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) break
    const isStartOfFrame =
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && marker >= 0xc0 && marker <= 0xcf
    if (isStartOfFrame) {
      if (length < 7) break
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4]
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6]
      return [width, height]
    }
    offset += length
  }
  return null
}

export function inspectPngJpegDimensions(
  bytes: Uint8Array,
  declaredMimeType?: unknown
): [number, number] {
  const png = inspectPng(bytes)
  const jpeg = png ? null : inspectJpeg(bytes)
  const actualMimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : null
  if (!actualMimeType) throw new Error('GLB contains an unsupported or malformed embedded image')
  if (
    declaredMimeType !== undefined &&
    declaredMimeType !== actualMimeType &&
    !(declaredMimeType === 'image/jpg' && actualMimeType === 'image/jpeg')
  ) {
    throw new Error('GLB embedded image MIME type does not match its bytes')
  }
  return png ?? (jpeg as [number, number])
}

function decodeImageDataUri(uri: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri)
  if (!match) throw new Error('GLB image data URI must be a base64 PNG or JPEG')
  let binary: string
  try {
    binary = atob(match[2])
  } catch {
    throw new Error('GLB contains an invalid base64 image')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return { bytes, mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1] }
}

function rejectExternalUris(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectExternalUris)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uri' && typeof child === 'string' && !child.startsWith('data:')) {
      throw new Error('GLB references an external resource; package every resource into the GLB')
    }
    rejectExternalUris(child)
  }
}

/** Validate that a GLB is structurally bounded and cannot trigger secondary network loads. */
export function validateSelfContainedGlb(
  buffer: ArrayBuffer,
  maxTexturePixels: number = MAX_GLB_TEXTURE_PIXELS
): void {
  if (buffer.byteLength < 20) throw new Error('GLB is too short')
  if (!Number.isSafeInteger(maxTexturePixels) || maxTexturePixels <= 0) {
    throw new Error('GLB texture pixel limit must be a positive safe integer')
  }
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
    throw new Error('Asset is not a GLB 2.0 container')
  }
  if (view.getUint32(8, true) !== buffer.byteLength) {
    throw new Error('GLB declared length does not match the downloaded bytes')
  }

  let offset = 12
  let jsonBytes: Uint8Array | null = null
  let binBytes: Uint8Array | null = null
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) throw new Error('GLB chunk header is truncated')
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + length
    if (end > buffer.byteLength || end < start) throw new Error('GLB chunk exceeds its container')
    if (type === JSON_CHUNK_TYPE && !jsonBytes) jsonBytes = new Uint8Array(buffer, start, length)
    if (type === BIN_CHUNK_TYPE && !binBytes) binBytes = new Uint8Array(buffer, start, length)
    offset = end
  }
  if (!jsonBytes) throw new Error('GLB has no JSON chunk')

  let manifest: unknown
  try {
    let json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
    while (json.endsWith('\0') || json.endsWith(' ')) json = json.slice(0, -1)
    manifest = JSON.parse(json)
  } catch {
    throw new Error('GLB JSON chunk is invalid UTF-8 or JSON')
  }
  if (!isRecord(manifest)) throw new Error('GLB manifest must be an object')
  rejectExternalUris(manifest)

  const buffers = manifest.buffers
  if (buffers !== undefined) {
    if (
      !Array.isArray(buffers) ||
      buffers.length > 1 ||
      buffers.some((entry) => !isRecord(entry))
    ) {
      throw new Error('GLB must use one embedded binary buffer')
    }
    if (buffers.some((entry) => isRecord(entry) && typeof entry.uri === 'string')) {
      throw new Error('GLB binary buffers must be embedded in the container')
    }
  }

  const images = manifest.images
  if (images === undefined) return
  if (!Array.isArray(images) || images.length > MAX_EMBEDDED_IMAGES) {
    throw new Error(`GLB may contain at most ${MAX_EMBEDDED_IMAGES} embedded images`)
  }
  const bufferViews: unknown[] = Array.isArray(manifest.bufferViews) ? manifest.bufferViews : []
  let totalPixels = 0
  for (const [imageIndex, rawImage] of images.entries()) {
    if (!isRecord(rawImage)) throw new Error(`GLB image ${imageIndex} is invalid`)
    let imageBytes: Uint8Array
    let declaredMimeType = rawImage.mimeType
    if (typeof rawImage.uri === 'string') {
      const decoded = decodeImageDataUri(rawImage.uri)
      imageBytes = decoded.bytes
      declaredMimeType ??= decoded.mimeType
    } else {
      const bufferViewIndex = safeInteger(rawImage.bufferView, `GLB image ${imageIndex} bufferView`)
      const rawBufferView = bufferViews[bufferViewIndex]
      if (!isRecord(rawBufferView) || !binBytes) {
        throw new Error(`GLB image ${imageIndex} does not reference an embedded buffer view`)
      }
      if (safeInteger(rawBufferView.buffer ?? 0, 'GLB buffer index') !== 0) {
        throw new Error('GLB image references a non-embedded buffer')
      }
      const byteOffset = safeInteger(rawBufferView.byteOffset ?? 0, 'GLB bufferView byteOffset')
      const byteLength = safeInteger(rawBufferView.byteLength, 'GLB bufferView byteLength')
      const end = byteOffset + byteLength
      if (!Number.isSafeInteger(end) || end > binBytes.byteLength) {
        throw new Error('GLB image bufferView exceeds the binary chunk')
      }
      imageBytes = binBytes.subarray(byteOffset, end)
    }
    const [width, height] = inspectPngJpegDimensions(imageBytes, declaredMimeType)
    if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      throw new Error(`GLB embedded image dimensions must be within 1-${MAX_IMAGE_DIMENSION}`)
    }
    const pixels = width * height
    if (!Number.isSafeInteger(pixels) || totalPixels + pixels > maxTexturePixels) {
      throw new Error(`GLB embedded textures exceed ${maxTexturePixels} aggregate pixels`)
    }
    totalPixels += pixels
  }
}
