import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ROSCameraStream, type DecodedFrame } from '../ROSCameraStream'
import type { Image } from '../types'

type RawDecoder = {
  decodeRawImage(msg: Image): Promise<DecodedFrame | null>
}

beforeAll(() => {
  vi.stubGlobal('ImageData', class {
    readonly data: Uint8ClampedArray
    readonly colorSpace = 'srgb'

    constructor(readonly width: number, readonly height: number) {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  })
})

const header = { stamp: { secs: 1, nsecs: 0 }, frame_id: 'camera' }

async function decodeRaw(stream: ROSCameraStream, msg: Image): Promise<DecodedFrame | null> {
  return (stream as unknown as RawDecoder).decodeRawImage(msg)
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
})
