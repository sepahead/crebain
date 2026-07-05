import { describe, expect, it } from 'vitest'
import { getTransportEventName, TRANSPORT_EVENT_PREFIX } from '../transportEvents'

const TAURI_EVENT_NAME_RE = /^[A-Za-z0-9/:_-]+$/

describe('transportEvents', () => {
  it('preserves safe ASCII characters', () => {
    expect(getTransportEventName('camera/image-raw1')).toBe(
      `${TRANSPORT_EVENT_PREFIX}camera/image-raw1`
    )
  })

  it('escapes underscores to keep the mapping bijective', () => {
    expect(getTransportEventName('/camera/image_raw')).toBe(
      `${TRANSPORT_EVENT_PREFIX}/camera/image_5Fraw`
    )
  })

  it('escapes UTF-8 bytes with uppercase hex', () => {
    expect(getTransportEventName('/über/image')).toBe(`${TRANSPORT_EVENT_PREFIX}/_C3_BCber/image`)
  })

  it('emits only Tauri-legal event name characters', () => {
    // Tauri 2.x EventName::new accepts only [a-zA-Z0-9-/:_].
    const name = getTransportEventName('/cam era/image_raw%~')
    expect(name).toBe(`${TRANSPORT_EVENT_PREFIX}/cam_20era/image_5Fraw_25_7E`)
    expect(name).toMatch(TAURI_EVENT_NAME_RE)
  })
})
