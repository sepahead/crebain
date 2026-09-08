import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_POLICY,
  ENGINE_MODEL,
  GAINS,
  GAMMA,
  PHYSICAL,
  PROFILE,
  U,
  allocate,
  allocateAttitudeFirst,
  attitude,
  compute,
  ownForceControllerConfig,
  ownTarget,
  momentCollectiveCeiling,
  reconstruct,
  type ForceControllerConfig,
  type State,
  type Target,
  type Vec,
} from '../ForceAttitudeController'

const config = (altitude = 23, heading = 0): ForceControllerConfig => ({
  engineModel: ENGINE_MODEL,
  referenceAltitudeM: altitude,
  referenceHeadingRad: heading,
})
const target = (altitude = 23): Target => ({
  kind: 'force_attitude_height',
  roll_rad: 0,
  pitch_rad: 0,
  heading_rad: 0,
  altitude_m: altitude,
})
const state = (altitude = 23): State => ({
  position: [0, altitude, 0],
  velocity: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  angularVelocity: [0, 0, 0],
  armed: true,
})

// Independent force geometry and capped reaction arithmetic; no allocator helper.
function moments(forces: number[]) {
  const [fl, fr, rl, rr] = forces
  return [
    0.25 * (-fl - fr + rl + rr),
    -Math.min(GAMMA * fl, 0.5) +
      Math.min(GAMMA * fr, 0.5) +
      Math.min(GAMMA * rl, 0.5) -
      Math.min(GAMMA * rr, 0.5),
    0.25 * (-fl + fr - rl + rr),
  ]
}

// Audit output from rotor geometry, rather than trusting reported achieved moments.
function expectFullMoments(
  allocation: ReturnType<typeof allocateAttitudeFirst>,
  force: number,
  requested: Vec
) {
  expect(allocation.policy).toBe('full-moments-before-collective-v1')
  expect(allocation.scale).toBe(1)
  expect(allocation.forces).toHaveLength(4)
  expect(allocation.forces.every((f) => Number.isFinite(f) && f >= 0 && f <= U)).toBe(true)
  const collective = allocation.forces.reduce((sum, f) => sum + f, 0)
  expect(collective).toBeLessThanOrEqual(Math.min(force, 4 * U) + 1e-12)
  expect(Math.abs(collective - allocation.achieved.collective)).toBeLessThanOrEqual(1e-12)
  for (const [axis, actual] of moments(allocation.forces).entries()) {
    expect(Math.abs(actual - requested[axis])).toBeLessThanOrEqual(1e-12)
    expect(Math.abs(actual - allocation.achieved.moments[axis])).toBeLessThanOrEqual(1e-12)
  }
}

describe('full moments before collective', () => {
  it.each([-0.05, 0.05])('retains signed yaw %s at the analytical maximum collective', (yaw) => {
    const request: Vec = [0, yaw, 0]
    const old = allocate(18, request)
    expect(Math.abs(moments(old.forces)[1] - yaw)).toBeGreaterThan(1e-3)
    const result = allocateAttitudeFirst(18, request)
    const maximum = 2 * (U + PHYSICAL.torqueCap / GAMMA) - Math.abs(yaw) / GAMMA
    expectFullMoments(result, 18, request)
    expect(Math.abs(result.boundedF - maximum)).toBeLessThanOrEqual(1e-12)
    expect(result.limitations.collective).toBe(true)
    expect(result.policy).toBe(ALLOCATION_POLICY)
    expect(momentCollectiveCeiling(18, request)).toBe(result.ceiling)
  })

  it('keeps feasible collective, including the rank-zero all-capped region', () => {
    for (const force of [0, (4 * PHYSICAL.torqueCap) / GAMMA, 4 * U]) {
      const row = allocateAttitudeFirst(force, [0, 0, 0])
      expectFullMoments(row, force, [0, 0, 0])
      expect(row.boundedF).toBe(force)
      expect(row.limitations.collective).toBe(false)
      expect(momentCollectiveCeiling(force, [0, 0, 0])).toBe(force)
    }
    const request: Vec = [0.01, 0.02, -0.01]
    const row = allocateAttitudeFirst(14.715, request)
    expectFullMoments(row, 14.715, request)
    expect(row.forces).toEqual(allocate(14.715, request).forces)
    expect(row.ceilingDecrements).toBe(0)
  })

  it('preserves combined-axis moments at conservative admitted-envelope corners', () => {
    const acceleration = GAINS.attitudeP * Math.sin(0.35) + GAINS.attitudeD
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          const request = [x, y, z].map(
            (sign, axis) => sign * PHYSICAL.inertia[axis] * acceleration
          ) as Vec
          const row = allocateAttitudeFirst(18, request)
          expectFullMoments(row, 18, request)
          expect(row.boundedF).toBeLessThan(18)
        }
  })

  it.each([
    [0, [0.01, 0, 0]],
    [0.001, [0, 0.05, 0]],
    [18, [100, 0, 0]],
  ] as Array<[number, Vec]>)(
    'rejects an infeasible full-moment request at collective %s',
    (force, requested) => {
      expect(() => momentCollectiveCeiling(force, requested)).toThrow('infeasible')
      expect(() => allocateAttitudeFirst(force, requested)).toThrow('infeasible')
    }
  )

  it('keeps the declared tolerance distinct from exact nonzero-yaw optimization', () => {
    const tolerated = allocateAttitudeFirst(4 * U, [0, 1e-12, 0])
    expectFullMoments(tolerated, 4 * U, [0, 1e-12, 0])
    expect(tolerated.boundedF).toBe(4 * U)
    expect(moments(tolerated.forces)[1]).toBe(0)
    const resolved = allocateAttitudeFirst(4 * U, [0, 2e-12, 0])
    expectFullMoments(resolved, 4 * U, [0, 2e-12, 0])
    expect(resolved.boundedF).toBeLessThan(tolerated.boundedF - 1)
  })

  it('rejects false policy and overstated achieved-moment evidence in the independent oracle', () => {
    const requested: Vec = [0.04, 0.05, -0.03]
    const row = allocateAttitudeFirst(18, requested)
    expectFullMoments(row, 18, requested)
    const policy = structuredClone(row)
    Object.assign(policy, { policy: 'collective-first' })
    expect(() => expectFullMoments(policy, 18, requested)).toThrow()
    const achieved = structuredClone(row)
    achieved.achieved.moments[1] += 0.001
    expect(() => expectFullMoments(achieved, 18, requested)).toThrow()
    expectFullMoments(row, 18, requested)
  })
})

describe('versioned force-attitude controller arithmetic', () => {
  it('uses source-derived equilibrium thrust and preserves actual motor/torque ceilings', () => {
    const result = compute(state(), target(), config())
    expect(result.profile).toBe(PROFILE)
    expect(result.allocation.forces).toEqual([3.67875, 3.67875, 3.67875, 3.67875])
    for (const value of Object.values(result.commands))
      expect(value).toBeCloseTo(0.8835142873587364, 14)
    expect(result.allocation.nullspace).toBe(0)
    expect(result.allocation.achieved.moments).toEqual([0, 0, 0])
    expect(U).toBeLessThan(PHYSICAL.thrustCap)
    expect(3.67875).toBeGreaterThan(PHYSICAL.torqueCap / GAMMA)
    expect(result.commands.front_left).not.toBe(0.5)
  })

  it.each([
    ['roll_rad', 2, -1],
    ['pitch_rad', 0, 1],
    ['heading_rad', 1, 1],
  ] as const)(
    'gives opposite physical moments for signed %s targets without derivative kick',
    (field, axis, sign) => {
      const plus = compute(state(), { ...target(), [field]: 0.03 }, config())
      const minus = compute(state(), { ...target(), [field]: -0.03 }, config())
      expect(Math.sign(plus.allocation.requestedMoments[axis])).toBe(sign)
      expect(plus.allocation.requestedMoments[axis]).toBeCloseTo(
        -minus.allocation.requestedMoments[axis],
        14
      )
      expect(Math.abs(plus.alpha[axis])).toBeCloseTo(GAINS.attitudeP * Math.sin(0.03), 14)
      expect(Object.values(plus.commands).every((u) => u > 0 && u < 1)).toBe(true)
      expect(plus.commands).not.toEqual(minus.commands)
    }
  )

  it('uses a body-frame measured rate and equivalent quaternion signs', () => {
    const angle = 0.1,
      c = Math.cos(angle),
      s = Math.sin(angle)
    const input = state()
    input.orientation = [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]
    input.angularVelocity = [0.1, c * 0.2 - s * 0.3, s * 0.2 + c * 0.3]
    const held = { ...target(), pitch_rad: angle }
    const first = compute(input, held, config())
    for (const [axis, value] of [0.1, 0.2, 0.3].entries())
      expect(first.geometry.omega[axis]).toBeCloseTo(value, 14)
    expect(first.geometry.omega[1]).not.toBeCloseTo(input.angularVelocity[1], 6)
    expect(first.alpha[1]).toBeCloseTo(-GAINS.attitudeD * 0.2, 14)
    const opposite = compute(
      { ...input, orientation: input.orientation.map((x) => -x) },
      held,
      config()
    )
    expect(opposite.commands).toEqual(first.commands)
  })

  it('owns generic finite reference data without any trial altitude or heading exception', () => {
    for (const altitude of [1, 23, 50, 100.25]) {
      const input = config(altitude, Math.PI - 0.04)
      const held = { ...target(altitude + 0.25), heading_rad: -Math.PI + 0.04 }
      const owned = ownTarget(held, input)
      expect(owned.altitude_m).toBe(altitude + 0.25)
      expect(Object.isFrozen(owned)).toBe(true)
      input.referenceAltitudeM = 700
      held.altitude_m = 900
      expect(owned.altitude_m).toBe(altitude + 0.25)
    }
    expect(() => ownTarget(target(23.51), config())).toThrow('target bound')
    expect(() => ownTarget({ ...target(), heading_rad: 0.21 }, config())).toThrow('target bound')
    expect(() =>
      ownForceControllerConfig({
        ...config(),
        engineModel: 'different',
      } as unknown as ForceControllerConfig)
    ).toThrow('engine model')
  })

  it('does not manufacture a target or accept malformed state, keys, numbers, or accessors', () => {
    expect(() => compute(state(), undefined as unknown as Target, config())).toThrow()
    const getter = { ...target() }
    Object.defineProperty(getter, 'roll_rad', {
      get() {
        throw new Error('accessor executed')
      },
      enumerable: true,
    })
    expect(() => compute(state(), getter, config())).toThrow('accessors')
    for (const broken of [
      { ...state(), extra: 1 },
      { ...state(), armed: 1 },
      { ...state(), position: [0, 23] },
      { ...state(), velocity: [NaN, 0, 0] },
      { ...state(), orientation: [0, 0, 0, 0] },
      { ...state(), orientation: [0, 0, 0, 1.001] },
      { ...state(), angularVelocity: [Infinity, 0, 0] },
      { ...state(), velocity: [5.001, 0, 0] },
    ])
      expect(() => compute(broken as State, target(), config())).toThrow()
    const raw = state()
    raw.orientation[3] = 1 + 1e-8
    const accepted = compute(raw, target(), config())
    expect(accepted.geometry.raw[3]).toBe(1 + 1e-8)
    expect(accepted.geometry.normalized[3]).toBe(1)
    expect(raw.orientation[3]).toBe(1 + 1e-8)
    expect(compute(state(), target(), config()).commands.front_left).toBeGreaterThan(0)
  })

  it('returns zero disarmed commands without changing requested versus applied allocation meaning', () => {
    const result = compute({ ...state(), armed: false }, target(), config())
    expect(Object.values(result.commands)).toEqual([0, 0, 0, 0])
    expect(result.allocation_applied).toBe(false)
    expect(result.allocation.boundedF).toBeGreaterThan(0)
    expect(compute(state(), target(), config()).allocation_applied).toBe(true)
  })

  it('preserves tilt feedforward and signed height response as distinct physical requests', () => {
    const input = state(),
      angle = 0.1
    input.orientation = [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]
    const result = compute(input, { ...target(), pitch_rad: angle }, config())
    expect(result.allocation.requestedF).toBeCloseTo((1.5 * 9.81) / Math.cos(angle), 12)
    const up = compute(state(), target(23.25), config())
    const down = compute(state(), target(22.75), config())
    expect(up.ay).toBeGreaterThan(0)
    expect(down.ay).toBeCloseTo(-up.ay, 14)
    expect(up.allocation.requestedF).toBeGreaterThan(down.allocation.requestedF)
  })

  it.each([
    [0, [0, 0, 0]],
    [4 * U, [0, 0, 0]],
    [14.715, [0.04, 0.03, -0.02]],
    [9, [6, -3, 4]],
    [18, [3, 1, -7]],
    [100, [0.1, 1, 0.2]],
  ] as Array<[number, [number, number, number]]>)(
    'preserves feasible priorities for F=%s',
    (force, requested) => {
      const row = allocate(force, requested)
      const actual = moments(row.forces)
      expect(row.forces.every((x) => x >= 0 && x <= U)).toBe(true)
      expect(row.forces.reduce((a, b) => a + b)).toBeCloseTo(row.boundedF, 11)
      expect(actual[0]).toBeCloseTo(requested[0] * row.scale, 11)
      expect(actual[2]).toBeCloseTo(requested[2] * row.scale, 11)
      expect(actual[1]).toBeCloseTo(row.limitedYaw, 11)
      expect(row.achieved.moments).toEqual(actual)
      if (row.scale < 1 - 1e-9) {
        // At a greater scale, no yaw-nullspace point can keep all four forces in bounds.
        const lambda = Math.min(1, row.scale + 1e-8)
        const p = lambda * requested[0],
          r = lambda * requested[2],
          f = row.boundedF / 4
        const base = [f - p - r, f - p + r, f + p - r, f + p + r]
        const lower = Math.max(base[0] - U, -base[1], -base[2], base[3] - U)
        const upper = Math.min(base[0], U - base[1], U - base[2], base[3])
        expect(lower).toBeGreaterThan(upper)
      }
    }
  )

  it('inverts capped yaw and explicitly reports the flat zero-authority interval', () => {
    const hover = allocate(14.715, [0, 0, 0])
    expect(hover.nullspace).toBe(0)
    expect(moments(hover.forces)[1]).toBe(0)
    for (const request of [-0.05, 0.05]) {
      const row = allocate(14.715, [0, request, 0])
      expect(moments(row.forces)[1]).toBeCloseTo(request, 12)
      expect(row.forces.some((x) => GAMMA * x > 0.5)).toBe(true)
      const uncapped = row.forces.reduce((sum, x, i) => sum + [-1, 1, 1, -1][i] * GAMMA * x, 0)
      expect(Math.abs(uncapped - request)).toBeGreaterThan(1e-4)
    }
    const lost = allocate(4 * U, [0, 0.1, 0])
    expect(lost.yawInterval).toEqual([0, 0])
    expect(lost.limitedYaw).toBe(0)
    expect(lost.limitations.yaw).toBe(true)
    expect(lost.achieved.moments[1]).not.toBe(0.1)
    for (const force of [NaN, Infinity, 1e7]) expect(() => allocate(force, [0, 0, 0])).toThrow()
    expect(reconstruct([0, 0, 0, 0]).collective).toBe(0)
  })

  it('excludes unmodeled gyroscopic compensation from held-target damping', () => {
    const input = { ...state(), angularVelocity: [0.2, 0.3, 0.4] }
    const result = compute(input, target(), config())
    const without = input.angularVelocity.map((x, i) => -GAINS.attitudeD * x * PHYSICAL.inertia[i])
    expect(result.allocation.requestedMoments).toEqual(without)
    expect(result.allocation.requestedMoments[0]).not.toBe(without[0] - 0.0012)
    expect(attitude(input, target()).error).toEqual([0, 0, 0])
  })
})
