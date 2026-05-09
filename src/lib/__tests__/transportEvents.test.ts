import { describe, expect, it } from 'vitest'
import { getTransportEventName, TRANSPORT_EVENT_PREFIX } from '../transportEvents'

describe('transportEvents', () => {
  it('preserves safe ASCII characters', () => {
    expect(getTransportEventName('camera.image-raw_1')).toBe(`${TRANSPORT_EVENT_PREFIX}camera.image-raw_1`)
  })

  it('percent-encodes ROS separators and spaces', () => {
    expect(getTransportEventName('/camera/image raw')).toBe(`${TRANSPORT_EVENT_PREFIX}%2Fcamera%2Fimage%20raw`)
  })

  it('percent-encodes UTF-8 bytes with uppercase hex', () => {
    expect(getTransportEventName('/über/image')).toBe(`${TRANSPORT_EVENT_PREFIX}%2F%C3%BCber%2Fimage`)
  })
})
