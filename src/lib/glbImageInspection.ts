const MAX_PNG_CHUNKS = 4096
const PNG_CRC32_POLYNOMIAL = 0xedb88320

export interface EncodedImageInspection {
  dimensions: [number, number]
  mimeType: 'image/png' | 'image/jpeg'
}

const PNG_CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let crc = index
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? PNG_CRC32_POLYNOMIAL : 0)
    }
    table[index] = crc >>> 0
  }
  return table
})()

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = PNG_CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)
}

function isValidPngBitDepth(bitDepth: number, colorType: number): boolean {
  switch (colorType) {
    case 0:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16
    case 2:
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16
    case 3:
      return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8
    default:
      return false
  }
}

function inspectPng(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 57 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let chunkCount = 0
  let width = 0
  let height = 0
  let colorType = -1
  let sawHeader = false
  let sawPalette = false
  let sawImageData = false
  let imageDataEnded = false

  while (offset < bytes.length) {
    chunkCount += 1
    if (chunkCount > MAX_PNG_CHUNKS || offset + 12 > bytes.length) return null

    const length = view.getUint32(offset, false)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcOffset = dataEnd
    const chunkEnd = crcOffset + 4
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length || dataEnd < dataStart) {
      return null
    }

    const typeBytes = bytes.subarray(typeStart, dataStart)
    if (typeBytes.length !== 4 || !typeBytes.every(isAsciiLetter) || (typeBytes[2] & 0x20) !== 0) {
      return null
    }
    if (view.getUint32(crcOffset, false) !== pngCrc32(bytes, typeStart, dataEnd)) return null

    const type = String.fromCharCode(typeBytes[0], typeBytes[1], typeBytes[2], typeBytes[3])
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return null
      width = view.getUint32(dataStart, false)
      height = view.getUint32(dataStart + 4, false)
      const bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      if (
        width === 0 ||
        height === 0 ||
        !isValidPngBitDepth(bitDepth, colorType) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] > 1
      ) {
        return null
      }
      sawHeader = true
    } else if (type === 'IHDR') {
      return null
    }

    if (type === 'PLTE') {
      if (
        sawPalette ||
        sawImageData ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        colorType === 0 ||
        colorType === 4
      ) {
        return null
      }
      sawPalette = true
    } else if (type === 'IDAT') {
      if (imageDataEnded || (colorType === 3 && !sawPalette)) return null
      sawImageData = true
    } else if (type === 'IEND') {
      if (
        length !== 0 ||
        !sawImageData ||
        (colorType === 3 && !sawPalette) ||
        chunkEnd !== bytes.length
      ) {
        return null
      }
      return [width, height]
    } else {
      if (sawImageData) imageDataEnded = true
      const isUnknownCriticalChunk = (typeBytes[0] & 0x20) === 0 && type !== 'IHDR'
      if (isUnknownCriticalChunk) return null
    }

    offset = chunkEnd
  }
  return null
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

export function inspectEncodedImage(bytes: Uint8Array): EncodedImageInspection {
  const png = inspectPng(bytes)
  const jpeg = png ? null : inspectJpeg(bytes)
  const actualMimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : null
  if (!actualMimeType) {
    throw new Error('GLB embedded image does not pass PNG/JPEG dimension preflight')
  }
  return {
    dimensions: png ?? (jpeg as [number, number]),
    mimeType: actualMimeType,
  }
}

export function validateDeclaredImageMimeType(
  actualMimeType: EncodedImageInspection['mimeType'],
  declaredMimeType: unknown
): void {
  if (
    declaredMimeType !== undefined &&
    declaredMimeType !== actualMimeType &&
    !(declaredMimeType === 'image/jpg' && actualMimeType === 'image/jpeg')
  ) {
    throw new Error('GLB embedded image MIME type does not match its bytes')
  }
}

export function inspectPngJpegDimensions(
  bytes: Uint8Array,
  declaredMimeType?: unknown
): [number, number] {
  const inspection = inspectEncodedImage(bytes)
  validateDeclaredImageMimeType(inspection.mimeType, declaredMimeType)
  return inspection.dimensions
}

export function decodeImageDataUri(uri: string): { bytes: Uint8Array; mimeType: string } {
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
