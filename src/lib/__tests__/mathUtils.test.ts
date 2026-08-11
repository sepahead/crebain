import { describe, expect, it } from 'vitest'
import { slerpQuaternion } from '../mathUtils'

describe('slerpQuaternion', () => {
  it('preserves both endpoints for nearly equal rotations', () => {
    const first = { x: 0, y: 0, z: 0, w: 1 }
    const angle = 0.001
    const second = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }

    expect(slerpQuaternion(first, second, 0)).toEqual(first)
    expect(slerpQuaternion(first, second, 1)).toEqual(second)
  })

  it('returns a unit quaternion on the near-equal interpolation path', () => {
    const result = slerpQuaternion(
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0.00025, z: 0, w: Math.sqrt(1 - 0.00025 ** 2) },
      0.25
    )

    expect(Math.hypot(result.x, result.y, result.z, result.w)).toBeCloseTo(1, 12)
    expect(result.y).toBeGreaterThan(0)
  })
})
