import { describe, expect, it } from 'vitest'
import { DRONE_TYPES } from '../DroneTypes'

describe('built-in drone model provenance boundary', () => {
  it('uses procedural meshes for every 0.9 built-in profile', () => {
    expect(Object.values(DRONE_TYPES).map(({ id, modelPath }) => [id, modelPath])).toEqual([
      ['maverick', null],
      ['shahed', null],
      ['fpv_racer', null],
      ['recon_hex', null],
      ['switchblade', null],
    ])
  })
})
