import { describe, expect, it } from 'vitest'
import {
  isAdmissibleRouteWaypoints,
  isFiniteRouteWaypoint,
  MAX_ROUTE_ALTITUDE_M,
  MAX_ROUTE_COORDINATE_MAGNITUDE_M,
  MAX_ROUTE_SPEED_MULTIPLIER,
  MAX_ROUTE_WAYPOINTS,
  parseWaypointInput,
} from '../routeLimits'
import { DRONE_TYPES } from '../../physics/DroneTypes'

const validWaypoint = {
  position: { x: 1, y: 0, z: -2 },
  altitude: 0,
}

describe('route limits', () => {
  it('keeps the global altitude envelope aligned with built-in profiles', () => {
    expect(Math.max(...Object.values(DRONE_TYPES).map((type) => type.physics.maxAltitude))).toBe(
      MAX_ROUTE_ALTITUDE_M
    )
  })

  it('preserves finite zeroes while rejecting incomplete and non-finite input', () => {
    expect(parseWaypointInput({ x: '0', y: '0', z: '-0' })).toEqual({ x: 0, y: 0, z: -0 })
    expect(parseWaypointInput({ x: '', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '1 trailing', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '1e999', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '1e308', y: '0', z: '0' })).toBeNull()
    expect(parseWaypointInput({ x: '0', y: '-1', z: '0' })).toBeNull()
  })

  it('admits exact numeric boundaries and rejects out-of-envelope route values', () => {
    expect(isFiniteRouteWaypoint(validWaypoint)).toBe(true)
    expect(
      parseWaypointInput({
        x: String(MAX_ROUTE_COORDINATE_MAGNITUDE_M),
        y: String(MAX_ROUTE_ALTITUDE_M),
        z: String(-MAX_ROUTE_COORDINATE_MAGNITUDE_M),
      })
    ).toEqual({
      x: MAX_ROUTE_COORDINATE_MAGNITUDE_M,
      y: MAX_ROUTE_ALTITUDE_M,
      z: -MAX_ROUTE_COORDINATE_MAGNITUDE_M,
    })
    expect(
      isFiniteRouteWaypoint({
        position: {
          x: MAX_ROUTE_COORDINATE_MAGNITUDE_M,
          y: MAX_ROUTE_ALTITUDE_M,
          z: -MAX_ROUTE_COORDINATE_MAGNITUDE_M,
        },
        altitude: MAX_ROUTE_ALTITUDE_M,
        speed: MAX_ROUTE_SPEED_MULTIPLIER,
      })
    ).toBe(true)
    expect(isFiniteRouteWaypoint({ ...validWaypoint, altitude: Number.NaN })).toBe(false)
    expect(
      isFiniteRouteWaypoint({
        ...validWaypoint,
        position: { ...validWaypoint.position, x: Infinity },
      })
    ).toBe(false)
    expect(isFiniteRouteWaypoint({ ...validWaypoint, speed: Number.NEGATIVE_INFINITY })).toBe(false)
    expect(isFiniteRouteWaypoint({ ...validWaypoint, speed: -0.01 })).toBe(false)
    expect(
      isFiniteRouteWaypoint({ ...validWaypoint, speed: MAX_ROUTE_SPEED_MULTIPLIER + 0.01 })
    ).toBe(false)
    expect(
      isFiniteRouteWaypoint({
        ...validWaypoint,
        position: {
          ...validWaypoint.position,
          x: MAX_ROUTE_COORDINATE_MAGNITUDE_M + 1,
        },
      })
    ).toBe(false)
    expect(isFiniteRouteWaypoint({ ...validWaypoint, altitude: MAX_ROUTE_ALTITUDE_M + 1 })).toBe(
      false
    )
  })

  it('supports a narrower drone-profile altitude ceiling without widening global caps', () => {
    expect(parseWaypointInput({ x: '0', y: '500', z: '0' }, { maxAltitude: 500 })).toEqual({
      x: 0,
      y: 500,
      z: 0,
    })
    expect(parseWaypointInput({ x: '0', y: '501', z: '0' }, { maxAltitude: 500 })).toBeNull()
    expect(
      isFiniteRouteWaypoint(
        { position: { x: 0, y: 501, z: 0 }, altitude: 501 },
        { maxAltitude: 500 }
      )
    ).toBe(false)
    expect(
      isFiniteRouteWaypoint(
        {
          position: { x: 0, y: MAX_ROUTE_ALTITUDE_M + 1, z: 0 },
          altitude: MAX_ROUTE_ALTITUDE_M + 1,
        },
        { maxAltitude: Number.MAX_VALUE }
      )
    ).toBe(false)
  })

  it('admits the named cap exactly and rejects one additional waypoint', () => {
    expect(
      isAdmissibleRouteWaypoints(Array.from({ length: MAX_ROUTE_WAYPOINTS }, () => validWaypoint))
    ).toBe(true)
    expect(
      isAdmissibleRouteWaypoints(
        Array.from({ length: MAX_ROUTE_WAYPOINTS + 1 }, () => validWaypoint)
      )
    ).toBe(false)
  })
})
