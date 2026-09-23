import { createHash } from 'node:crypto'
import { SourceGraphicsTransferError } from '../../src/environment/GraphicsSourceErrors.js'
export { SourceGraphicsTransferError } from '../../src/environment/GraphicsSourceErrors.js'

export const SOURCE_PLAN_BYTES = 512 * 1024
export const SOURCE_INPUT_BYTES = 128 * 1024
export const SOURCE_CHUNK_BYTES = 32768
export const SOURCE_CHUNK_FRAME_BYTES = 65536
const MAX_BASE64 = 4 * Math.ceil(SOURCE_CHUNK_BYTES / 3)
const DIGEST = /^[a-f0-9]{64}$/

export function sourceIntegrity(message, cause) {
  return new SourceGraphicsTransferError('integrity', message, cause)
}

export function sourceDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function encodeSourceJson(value, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > SOURCE_PLAN_BYTES)
    throw sourceIntegrity('Invalid source input capacity')
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw sourceIntegrity('Non-finite source transfer input')
    return Object.is(item, -0) ? { binary64: 'negative-zero' } : item
  })
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes)
    throw sourceIntegrity('Source transfer input exceeds its encoded bound')
  return text
}

export function parseSourceJson(text, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > SOURCE_PLAN_BYTES)
    throw sourceIntegrity('Invalid source input capacity')
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes)
    throw sourceIntegrity('Source transfer input must be bounded JSON text')
  try {
    return JSON.parse(text, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw sourceIntegrity('Non-finite source transfer value')
      return value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        value.binary64 === 'negative-zero'
        ? -0
        : value
    })
  } catch (error) {
    throw sourceIntegrity('Invalid source transfer JSON', error)
  }
}

export function closedSourceObject(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join('|') !== [...fields].sort().join('|')
  )
    throw sourceIntegrity('Source transfer requires a closed object')
  return value
}

export function sourceSelection(plan, source, input, destinationBytes) {
  closedSourceObject(source, ['kind', 'cameraId'])
  if (!['rgb', 'thermal'].includes(source.kind)) throw sourceIntegrity('Unknown source kind')
  const rows = source.kind === 'rgb' ? plan.scene.rgbCameras : plan.scene.thermalCameras
  const camera = rows.find((row) => row.id === source.cameraId)
  if (
    !camera ||
    !Number.isSafeInteger(input.tick) ||
    input.tick < 0 ||
    input.tick > 7200 ||
    input.tick % camera.periodTicks !== 0 ||
    destinationBytes !== 4 * camera.width * camera.height
  )
    throw sourceIntegrity('Source selection, cadence, or destination extent changed')
  return camera
}

export function admitSourceReceipt(value, { planSha256, input, source, camera, sequence }) {
  closedSourceObject(value, ['schema', 'sequence', 'receipt', 'originalSha256'])
  const receipt = closedSourceObject(value.receipt, [
    'planSha256',
    'inputSha256',
    'tick',
    'kind',
    'cameraId',
    'width',
    'height',
    'rowOrigin',
    'encoding',
    'byteLength',
  ])
  if (
    value.schema !== 'crebain.private-graphics-source.v1' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence !== sequence ||
    typeof value.originalSha256 !== 'string' ||
    !DIGEST.test(value.originalSha256) ||
    receipt.planSha256 !== planSha256 ||
    receipt.inputSha256 !== sourceDigest(encodeSourceJson(input, SOURCE_INPUT_BYTES)) ||
    receipt.tick !== input.tick ||
    receipt.kind !== source.kind ||
    receipt.cameraId !== source.cameraId ||
    receipt.width !== camera.width ||
    receipt.height !== camera.height ||
    receipt.rowOrigin !== 'bottom-left' ||
    receipt.encoding !== (source.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le') ||
    receipt.byteLength !== 4 * camera.width * camera.height
  )
    throw sourceIntegrity('Retained original receipt changed')
  return value
}

export function decodeSourceChunk(value, lease, offset) {
  // The worker is private and trusted. This check bounds accepted serialized output,
  // not the JSON IPC parser's allocations before delivery to this function.
  if (Buffer.byteLength(JSON.stringify(value)) > SOURCE_CHUNK_FRAME_BYTES)
    throw sourceIntegrity('Private source chunk exceeds its encoded bound')
  closedSourceObject(value, ['sequence', 'originalSha256', 'offset', 'bytesBase64', 'chunkSha256'])
  if (
    value.sequence !== lease.sequence ||
    value.originalSha256 !== lease.originalSha256 ||
    value.offset !== offset ||
    typeof value.bytesBase64 !== 'string' ||
    value.bytesBase64.length > MAX_BASE64 ||
    typeof value.chunkSha256 !== 'string' ||
    !DIGEST.test(value.chunkSha256)
  )
    throw sourceIntegrity('Private source chunk identity changed')
  const bytes = Buffer.from(value.bytesBase64, 'base64')
  const length = Math.min(SOURCE_CHUNK_BYTES, lease.receipt.byteLength - offset)
  if (
    length <= 0 ||
    bytes.length !== length ||
    bytes.toString('base64') !== value.bytesBase64 ||
    sourceDigest(bytes) !== value.chunkSha256
  )
    throw sourceIntegrity('Private source chunk bytes changed')
  return bytes
}

/** Copy one actual browser original into an already reserved parent destination. */
export async function copyRetainedSource(
  request,
  plan,
  planSha256,
  input,
  source,
  destination,
  sequence
) {
  if (
    Object.getPrototypeOf(destination) !== Uint8Array.prototype ||
    !(destination.buffer instanceof ArrayBuffer)
  )
    throw sourceIntegrity('Source transfer requires an owned Uint8Array destination')
  const inputJson = encodeSourceJson(input, SOURCE_INPUT_BYTES)
  const camera = sourceSelection(plan, source, input, destination.byteLength)
  if (input.planSha256 !== planSha256) throw sourceIntegrity('Source transfer plan changed')
  const lease = admitSourceReceipt(await request('capture_source', { inputJson, source }), {
    planSha256,
    input,
    source,
    camera,
    sequence,
  })
  const hash = createHash('sha256')
  for (let offset = 0; offset < destination.byteLength; offset += SOURCE_CHUNK_BYTES) {
    const result = await request('read_source', {
      sequence: lease.sequence,
      originalSha256: lease.originalSha256,
      offset,
    })
    const bytes = decodeSourceChunk(result, lease, offset)
    hash.update(bytes)
    destination.set(bytes, offset)
  }
  if (hash.digest('hex') !== lease.originalSha256)
    throw sourceIntegrity('Complete source original digest changed')
  const released = closedSourceObject(
    await request('release_source', {
      sequence: lease.sequence,
      originalSha256: lease.originalSha256,
    }),
    ['sequence', 'originalSha256', 'released']
  )
  if (
    released.sequence !== lease.sequence ||
    released.originalSha256 !== lease.originalSha256 ||
    released.released !== true
  )
    throw sourceIntegrity('Browser source release changed')
  return lease.receipt
}
