import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CAMERA_DECODE_WORKERS,
  MAX_CAMERA_DIMENSION,
  ROSCameraStream,
  type DecodedFrame,
} from '../ROSCameraStream'
import type { CompressedImage, Image } from '../types'
import type { ROSBridge } from '../ROSBridge'

type RawDecoder = {
  decodeRawImage(msg: Image): Promise<DecodedFrame | null>
}

type CompressedDecoder = {
  decodeCompressedImage(msg: CompressedImage): Promise<DecodedFrame | null>
}

class FakeImageBitmap {
  close = vi.fn()

  constructor(readonly width: number, readonly height: number) {}
}

beforeAll(() => {
  vi.stubGlobal('ImageData', class {
    readonly data: Uint8ClampedArray
    readonly colorSpace = 'srgb'

    constructor(readonly width: number, readonly height: number) {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  })
  vi.stubGlobal('ImageBitmap', FakeImageBitmap)
})

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('ImageData', class {
    readonly data: Uint8ClampedArray
    readonly colorSpace = 'srgb'

    constructor(readonly width: number, readonly height: number) {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  })
  vi.stubGlobal('ImageBitmap', FakeImageBitmap)
})

const header = { stamp: { secs: 1, nsecs: 0 }, frame_id: 'camera' }

async function decodeRaw(stream: ROSCameraStream, msg: Image): Promise<DecodedFrame | null> {
  return (stream as unknown as RawDecoder).decodeRawImage(msg)
}

async function decodeCompressed(
  stream: ROSCameraStream,
  msg: CompressedImage
): Promise<DecodedFrame | null> {
  return (stream as unknown as CompressedDecoder).decodeCompressedImage(msg)
}

function jpeg(width = 2, height = 2): Uint8Array {
  // Minimal marker sequence for the bounded header preflight. Browser decode is
  // stubbed in these unit tests; a real decoder remains the final syntax check.
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ])
}

function compressedMessage(sequence: number, data = jpeg()): CompressedImage {
  return {
    header: { ...header, seq: sequence },
    format: 'jpeg',
    data,
  }
}

function bridgeHarness() {
  let compressedCallback: ((message: CompressedImage) => void) | undefined
  const unsubscribe = vi.fn()
  const bridge = {
    subscribe: vi.fn(
      (
        _topic: string,
        type: string,
        callback: (message: CompressedImage) => void
      ) => {
        if (type === 'sensor_msgs/CompressedImage') compressedCallback = callback
        return unsubscribe
      }
    ),
  } as unknown as ROSBridge
  return {
    bridge,
    unsubscribe,
    receive: (message: CompressedImage) => compressedCallback?.(message),
  }
}

describe('ROSCameraStream raw image decoding', () => {
  it('decodes padded rgb8 rows using the ROS step field', async () => {
    const stream = new ROSCameraStream({ useImageBitmap: false })
    const msg: Image = {
      header,
      width: 2,
      height: 2,
      encoding: 'rgb8',
      is_bigendian: 0,
      step: 8,
      data: new Uint8Array([
        255, 0, 0, 0, 255, 0, 99, 99,
        0, 0, 255, 255, 255, 255, 88, 88,
      ]),
    }

    const frame = await decodeRaw(stream, msg)

    expect(frame).not.toBeNull()
    expect(frame?.image).toBeInstanceOf(ImageData)
    expect(Array.from((frame?.image as ImageData).data)).toEqual([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ])
  })

  it('rejects raw images whose step is too small for the encoding', async () => {
    const stream = new ROSCameraStream({ useImageBitmap: false })
    const msg: Image = {
      header,
      width: 2,
      height: 1,
      encoding: 'rgb8',
      is_bigendian: 0,
      step: 5,
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
    }

    await expect(decodeRaw(stream, msg)).resolves.toBeNull()
  })

  it('rejects explicit zero step instead of treating it as tightly packed', async () => {
    const stream = new ROSCameraStream({ useImageBitmap: false })
    const msg: Image = {
      header,
      width: 1,
      height: 1,
      encoding: 'rgb8',
      is_bigendian: 0,
      step: 0,
      data: new Uint8Array([1, 2, 3]),
    }

    await expect(decodeRaw(stream, msg)).resolves.toBeNull()
  })

  it('rejects raw dimensions whose RGBA allocation exceeds the common bound', async () => {
    const stream = new ROSCameraStream({ useImageBitmap: false })
    const msg: Image = {
      header,
      width: MAX_CAMERA_DIMENSION,
      height: MAX_CAMERA_DIMENSION,
      encoding: 'mono8',
      is_bigendian: 0,
      step: MAX_CAMERA_DIMENSION,
      data: new Uint8Array(),
    }

    await expect(decodeRaw(stream, msg)).resolves.toBeNull()
  })

  it('rejects malformed byte arrays before converting them', async () => {
    const stream = new ROSCameraStream({ useImageBitmap: false })
    const msg: Image = {
      header,
      width: 1,
      height: 1,
      encoding: 'rgb8',
      is_bigendian: 0,
      step: 3,
      data: [0, 256, 1],
    }

    await expect(decodeRaw(stream, msg)).resolves.toBeNull()
  })
})

describe('ROSCameraStream compressed ingress', () => {
  it('checks the declared codec, signature, and dimensions before browser decode', async () => {
    const createBitmap = vi.fn(async () => new FakeImageBitmap(2, 2))
    vi.stubGlobal('createImageBitmap', createBitmap)
    const stream = new ROSCameraStream({ useImageBitmap: true })

    await expect(
      decodeCompressed(stream, { ...compressedMessage(1), format: 'png' })
    ).resolves.toBeNull()
    await expect(
      decodeCompressed(stream, compressedMessage(2, new Uint8Array([1, 2, 3])))
    ).resolves.toBeNull()
    await expect(
      decodeCompressed(stream, compressedMessage(3, jpeg(MAX_CAMERA_DIMENSION, MAX_CAMERA_DIMENSION)))
    ).resolves.toBeNull()

    expect(createBitmap).not.toHaveBeenCalled()
  })

  it('closes a decoded bitmap whose dimensions disagree with the encoded header', async () => {
    const mismatched = new FakeImageBitmap(3, 2)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => mismatched))
    const stream = new ROSCameraStream({ useImageBitmap: true })

    await expect(decodeCompressed(stream, compressedMessage(1))).resolves.toBeNull()

    expect(mismatched.close).toHaveBeenCalledTimes(1)
  })

  it('allows only one decode plus one latest pending frame', async () => {
    const resolvers: Array<(bitmap: FakeImageBitmap) => void> = []
    let activeDecodes = 0
    let maximumActiveDecodes = 0
    const createBitmap = vi.fn(
      () =>
        new Promise<FakeImageBitmap>((resolve) => {
          activeDecodes += 1
          maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes)
          resolvers.push((bitmap) => {
            activeDecodes -= 1
            resolve(bitmap)
          })
        })
    )
    vi.stubGlobal('createImageBitmap', createBitmap)
    const harness = bridgeHarness()
    const stream = new ROSCameraStream({
      compressedTopic: '/camera/compressed',
      useImageBitmap: true,
    })
    const sequences: number[] = []
    stream.onFrame((frame) => sequences.push(frame.sequence))
    stream.start(harness.bridge)

    harness.receive(compressedMessage(1))
    harness.receive(compressedMessage(2))
    harness.receive(compressedMessage(3))
    expect(createBitmap).toHaveBeenCalledTimes(1)

    resolvers[0](new FakeImageBitmap(2, 2))
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2))
    resolvers[1](new FakeImageBitmap(2, 2))
    await vi.waitFor(() => expect(sequences).toEqual([1, 3]))

    expect(maximumActiveDecodes).toBe(1)
    expect(stream.getStats()).toMatchObject({
      framesReceived: 3,
      framesDecoded: 2,
      framesDropped: 1,
    })
  })

  it('recovers after restart while the prior decode remains unresolved and closes it later', async () => {
    const resolvers: Array<(bitmap: FakeImageBitmap) => void> = []
    let activeDecodes = 0
    let maximumActiveDecodes = 0
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise<FakeImageBitmap>((resolve) => {
            activeDecodes += 1
            maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes)
            resolvers.push((bitmap) => {
              activeDecodes -= 1
              resolve(bitmap)
            })
          })
      )
    )
    const firstHarness = bridgeHarness()
    const secondHarness = bridgeHarness()
    const stream = new ROSCameraStream({
      compressedTopic: '/camera/compressed',
      useImageBitmap: true,
    })
    const sequences: number[] = []
    stream.onFrame((frame) => sequences.push(frame.sequence))
    stream.start(firstHarness.bridge)
    firstHarness.receive(compressedMessage(1))

    stream.stop()
    stream.start(secondHarness.bridge)
    secondHarness.receive(compressedMessage(2))
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))

    // The current generation completes even though generation one has still
    // never settled.
    resolvers[1](new FakeImageBitmap(2, 2))
    await vi.waitFor(() => expect(sequences).toEqual([2]))

    const staleBitmap = new FakeImageBitmap(2, 2)
    resolvers[0](staleBitmap)
    await vi.waitFor(() => expect(staleBitmap.close).toHaveBeenCalledTimes(1))

    expect(maximumActiveDecodes).toBe(MAX_CAMERA_DECODE_WORKERS)
    expect(stream.getStats()).toMatchObject({
      framesReceived: 1,
      framesDecoded: 1,
      framesDropped: 0,
    })
  })

  it('keeps the cross-generation decode cap strict across repeated restarts', async () => {
    const resolvers: Array<(bitmap: FakeImageBitmap) => void> = []
    let activeDecodes = 0
    let maximumActiveDecodes = 0
    const createBitmap = vi.fn(
      () =>
        new Promise<FakeImageBitmap>((resolve) => {
          activeDecodes += 1
          maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes)
          resolvers.push((bitmap) => {
            activeDecodes -= 1
            resolve(bitmap)
          })
        })
    )
    vi.stubGlobal('createImageBitmap', createBitmap)
    const harnesses = [bridgeHarness(), bridgeHarness(), bridgeHarness()]
    const stream = new ROSCameraStream({
      compressedTopic: '/camera/compressed',
      useImageBitmap: true,
    })
    const sequences: number[] = []
    stream.onFrame((frame) => sequences.push(frame.sequence))

    for (let generation = 0; generation < harnesses.length; generation += 1) {
      if (generation > 0) stream.stop()
      stream.start(harnesses[generation].bridge)
      harnesses[generation].receive(compressedMessage(generation + 1))
    }

    expect(createBitmap).toHaveBeenCalledTimes(MAX_CAMERA_DECODE_WORKERS)
    resolvers[0](new FakeImageBitmap(2, 2))
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(3))
    resolvers[2](new FakeImageBitmap(2, 2))
    await vi.waitFor(() => expect(sequences).toEqual([3]))
    resolvers[1](new FakeImageBitmap(2, 2))

    expect(maximumActiveDecodes).toBe(MAX_CAMERA_DECODE_WORKERS)
  })
})
