import { describe, expect, it } from 'vitest'
import { ROSBridge, validateRosUrl } from '../ROSBridge'

describe('ROSBridge URL validation', () => {
  it('accepts websocket URLs', () => {
    expect(validateRosUrl('ws://localhost:9090')).toEqual({ valid: true })
    expect(validateRosUrl('wss://ros.example.com/bridge')).toEqual({ valid: true })
  })

  it('rejects non-websocket schemes', () => {
    expect(validateRosUrl('http://localhost:9090')).toMatchObject({
      valid: false,
      error: 'Invalid scheme: http:. Only ws:// and wss:// are allowed.',
    })
  })

  it('rejects malformed URLs', () => {
    expect(validateRosUrl('not-a-url')).toMatchObject({
      valid: false,
      error: 'Invalid URL format',
    })
  })

  it('rejects invalid hostname formats', () => {
    expect(validateRosUrl('ws://-bad-host:9090')).toMatchObject({
      valid: false,
      error: 'Invalid hostname format',
    })
  })

  it('throws when constructed with an invalid URL', () => {
    expect(() => new ROSBridge({ url: 'file:///tmp/socket' })).toThrow('Invalid ROS bridge URL')
  })
})
