import { describe, expect, it } from 'vitest'
import { namespacedRosTopic, normalizeRosNamespace } from '../utils'

describe('ROS namespace utilities', () => {
  it('normalizes namespaces with leading and trailing slashes', () => {
    expect(normalizeRosNamespace('/drone1/')).toBe('drone1')
    expect(normalizeRosNamespace('///fleet/drone1///')).toBe('fleet/drone1')
    expect(normalizeRosNamespace(' drone1 ')).toBe('drone1')
  })

  it('builds namespaced topics without duplicate slashes', () => {
    expect(namespacedRosTopic('/drone1/', '/mavros/state')).toBe('/drone1/mavros/state')
    expect(namespacedRosTopic('fleet/drone1', 'mavros/local_position/pose')).toBe(
      '/fleet/drone1/mavros/local_position/pose'
    )
  })

  it('builds root topics for empty namespaces', () => {
    expect(namespacedRosTopic('', '/mavros/state')).toBe('/mavros/state')
    expect(namespacedRosTopic('   ', 'mavros/state')).toBe('/mavros/state')
  })
})
