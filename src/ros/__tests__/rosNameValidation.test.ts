import { describe, expect, it } from 'vitest'

import {
  MAX_ROS_GRAPH_NAME_LENGTH,
  isValidRosGraphName,
  validateRosGraphName,
} from '../rosNameValidation'

describe('ROS graph-name validation', () => {
  it('accepts bounded fully qualified names with hidden tokens', () => {
    expect(isValidRosGraphName('/camera/front_1/image_raw')).toBe(true)
    expect(isValidRosGraphName('/_hidden/status')).toBe(true)
    expect(isValidRosGraphName(`/${'a'.repeat(MAX_ROS_GRAPH_NAME_LENGTH - 1)}`)).toBe(true)
  })

  it.each([
    'camera/front',
    '/',
    '/camera/',
    '/camera//raw',
    '/9camera/raw',
    '/camera/2raw',
    '/camera/raw-image',
    '/camera raw',
    `/${'a'.repeat(MAX_ROS_GRAPH_NAME_LENGTH)}`,
  ])('rejects the noncanonical graph name %s', (name) => {
    expect(isValidRosGraphName(name)).toBe(false)
    expect(() => validateRosGraphName(name, 'topic')).toThrow('Invalid ROS topic')
  })
})
