/** Pure bounded control for the explicitly selected default-quad Rapier profile. */
import * as THREE from 'three'
import { copyPlainData } from '../lib/copyPlainData'

export const PROFILE = 'crebain.rapier-force-attitude.v1'
export const ENGINE_MODEL = 'rapier-0.19.3-observed-no-gyro-v1'
export const ALLOCATION_POLICY = 'full-moments-before-collective-v1'
export const H = 1 / 120
export const MOTOR_POLE = 11 / 12
export const TAU_M = -H / Math.log(MOTOR_POLE)
export const GAINS = Object.freeze({
  attitudeP: (0.2 / TAU_M) ** 2,
  attitudeD: (2 * 0.2) / TAU_M,
  altitudeP: (0.1 / TAU_M) ** 2,
  altitudeD: (2 * 0.1) / TAU_M,
})
export const PHYSICAL = Object.freeze({
  mass: 1.5,
  gravity: 9.81,
  arm: 0.25,
  inertia: Object.freeze([0.01, 0.02, 0.01]),
  kt: 1.91e-6,
  kq: 2.6e-7,
  maxRpm: 15000,
  thrustCap: 15,
  torqueCap: 0.5,
})
export const OMEGA_MAX = (PHYSICAL.maxRpm * 2 * Math.PI) / 60
export const U = Math.min(PHYSICAL.thrustCap, PHYSICAL.kt * OMEGA_MAX ** 2)
export const GAMMA = PHYSICAL.kq / PHYSICAL.kt
/** Steady thrust headroom; motor lag and transient tracking remain separately measured. */
export const LIMITS = Object.freeze({
  maximumTiltRad: 0.35,
  verticalAccelerationMps2: 0.75 * ((4 * U * Math.cos(0.35)) / PHYSICAL.mass - PHYSICAL.gravity),
})
export const NAMES = ['front_left', 'front_right', 'rear_left', 'rear_right'] as const
export const DIRECTIONS = [-1, 1, 1, -1] as const
const FTOL = 1e-12
const MTOL = 1e-12
export type Vec = [number, number, number]
export type Motors = Record<(typeof NAMES)[number], number>
export interface Target {
  kind: 'force_attitude_height'
  roll_rad: number
  pitch_rad: number
  heading_rad: number
  altitude_m: number
}
export interface State {
  position: number[]
  velocity: number[]
  orientation: number[]
  angularVelocity: number[]
  armed: boolean
}
/** Reference bounds are owned plan data, independent from any trial location. */
export interface ForceControllerConfig {
  engineModel: typeof ENGINE_MODEL
  referenceAltitudeM: number
  referenceHeadingRad: number
}
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  require(value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('|') ===
      [...keys].sort().join('|'), 'Closed force-controller object required')
}
export function ownForceControllerConfig(
  input: ForceControllerConfig
): Readonly<ForceControllerConfig> {
  const config = copyPlainData(input)
  exactKeys(config, ['engineModel', 'referenceAltitudeM', 'referenceHeadingRad'])
  require(config.engineModel === ENGINE_MODEL, 'Unsupported force-controller engine model')
  finite(config.referenceAltitudeM)
  finite(config.referenceHeadingRad)
  require(Math.abs(config.referenceAltitudeM) <= 99999 &&
    Math.abs(config.referenceHeadingRad) <=
      Math.PI, 'Controller reference outside operating bounds')
  return config
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function finite(value: unknown): asserts value is number {
  require(typeof value === 'number' && Number.isFinite(value), 'Expected finite binary64')
}
function vector(values: number[], count: number): void {
  require(Array.isArray(values) && values.length === count, 'Wrong vector dimension')
  for (const value of values) finite(value)
}
export function ownTarget(input: Target, inputConfig: ForceControllerConfig): Readonly<Target> {
  const config = ownForceControllerConfig(inputConfig)
  const target = copyPlainData(input)
  exactKeys(target, ['altitude_m', 'heading_rad', 'kind', 'pitch_rad', 'roll_rad'])
  require(target.kind === 'force_attitude_height', 'Unsupported target kind')
  for (const x of [target.roll_rad, target.pitch_rad, target.heading_rad, target.altitude_m])
    finite(x)
  require(Math.abs(target.roll_rad) <= 0.1 &&
    Math.abs(target.pitch_rad) <= 0.1, 'Target tilt bound')
  require(Math.abs(target.heading_rad) <= Math.PI &&
    Math.abs(
      Math.atan2(
        Math.sin(target.heading_rad - config.referenceHeadingRad),
        Math.cos(target.heading_rad - config.referenceHeadingRad)
      )
    ) <= 0.2 &&
    Math.abs(target.altitude_m - config.referenceAltitudeM) <=
      0.5, 'Heading or altitude target bound')
  return Object.freeze(target)
}
export function desiredQuaternion(target: Target): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(target.pitch_rad, target.heading_rad, -target.roll_rad, 'YXZ')
  )
}
export function orientation(raw: number[]) {
  vector(raw, 4)
  const n = Math.sqrt(raw[0] ** 2 + raw[1] ** 2 + raw[2] ** 2 + raw[3] ** 2)
  require(Number.isFinite(n) && Math.abs(n - 1) <= 1e-6, 'Quaternion norm outside admission')
  const normalized = raw.map((x) => x / n)
  return {
    norm: n,
    normalized,
    quaternion: new THREE.Quaternion(...(normalized as [number, number, number, number])),
  }
}
export function attitude(state: State, target: Target) {
  vector(state.position, 3)
  vector(state.velocity, 3)
  vector(state.angularVelocity, 3)
  require(typeof state.armed === 'boolean', 'Armed state must be Boolean')
  const q = orientation(state.orientation)
  const desired = desiredQuaternion(target)
  const relative = desired.clone().invert().multiply(q.quaternion)
  const A = new THREE.Matrix4().makeRotationFromQuaternion(relative).elements
  // A = Rd^T R, column-major. vee((A-A^T)/2).
  const error: Vec = [(A[6] - A[9]) / 2, (A[8] - A[2]) / 2, (A[1] - A[4]) / 2]
  const omega = new THREE.Vector3(...(state.angularVelocity as Vec))
    .applyQuaternion(q.quaternion.clone().invert())
    .toArray()
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q.quaternion)
  const relativeAngle = 2 * Math.acos(Math.min(1, Math.abs(relative.w)))
  const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)))
  return {
    raw: [...state.orientation],
    normalized: q.normalized,
    norm: q.norm,
    error,
    omega,
    up: up.toArray(),
    relativeAngle,
    tilt,
  }
}
export function checkEnvelope(state: State, target: Target) {
  const geometry = attitude(state, target)
  require(geometry.tilt <= LIMITS.maximumTiltRad &&
    geometry.relativeAngle <= 0.35, 'Attitude envelope exceeded')
  require(Math.hypot(...geometry.omega) <= 1 &&
    Math.hypot(...state.velocity) <= 5, 'Rate or speed envelope exceeded')
  require(state.position.every((value) => Math.abs(value) <= 100000), 'Position envelope exceeded')
  require(state.position[1] > 0.05, 'Ground clearance envelope exceeded')
  return geometry
}
function baseForces(F: number, x: number, z: number, scale: number): number[] {
  const p = (scale * x) / (4 * PHYSICAL.arm),
    r = (scale * z) / (4 * PHYSICAL.arm)
  return [F / 4 - p - r, F / 4 - p + r, F / 4 + p - r, F / 4 + p + r]
}
function interval(b: number[]): [number, number] {
  return [
    Math.max(...b.map((x, i) => (DIRECTIONS[i] === 1 ? -x : x - U))),
    Math.min(...b.map((x, i) => (DIRECTIONS[i] === 1 ? U - x : x))),
  ]
}
function nextDown(value: number): number {
  require(value > 0 && Number.isFinite(value), 'Cannot decrement scale')
  const buffer = new ArrayBuffer(8),
    view = new DataView(buffer)
  view.setFloat64(0, value, false)
  view.setBigUint64(0, view.getBigUint64(0, false) - 1n, false)
  return view.getFloat64(0, false)
}
export function reconstruct(forces: number[]) {
  require(forces.length === 4, 'Four forces required')
  forces.forEach(finite)
  const l = PHYSICAL.arm
  return {
    collective: forces.reduce((a, b) => a + b, 0),
    moments: [
      l * (-forces[0] - forces[1] + forces[2] + forces[3]),
      forces.reduce(
        (sum, f, i) => sum + DIRECTIONS[i] * Math.min(GAMMA * f, PHYSICAL.torqueCap),
        0
      ),
      l * (-forces[0] + forces[1] - forces[2] + forces[3]),
    ] as Vec,
  }
}
export function allocate(requestedF: number, requestedMoments: Vec) {
  finite(requestedF)
  vector(requestedMoments, 3)
  require(Math.abs(requestedF) <= 1e6 &&
    requestedMoments.every(
      (value) => Math.abs(value) <= 1e6
    ), 'Allocation request exceeds arithmetic bounds')
  const F = Math.max(0, Math.min(4 * U, requestedF))
  const [tx, ty, tz] = requestedMoments
  const intercept = baseForces(F, tx, tz, 0),
    full = baseForces(F, tx, tz, 1)
  const slopes = full.map((v, i) => v - intercept[i])
  const lower = intercept.map((v, i) =>
    DIRECTIONS[i] === 1 ? [-v, -slopes[i]] : [v - U, slopes[i]]
  )
  const upper = intercept.map((v, i) =>
    DIRECTIONS[i] === 1 ? [U - v, -slopes[i]] : [v, slopes[i]]
  )
  let scale = 1
  for (const lo of lower)
    for (const hi of upper) {
      const coefficient = lo[1] - hi[1],
        available = hi[0] - lo[0]
      require(available >= 0, 'Zero-scale infeasible')
      if (coefficient > 0) scale = Math.min(scale, available / coefficient)
    }
  require(Number.isFinite(scale) && scale >= 0 && scale <= 1, 'Invalid scale')
  const initialScale = scale
  let b = baseForces(F, tx, tz, scale),
    [L, R] = interval(b),
    decrements = 0
  while (L > R && decrements < 8 && scale > 0) {
    scale = nextDown(scale)
    decrements++
    b = baseForces(F, tx, tz, scale)
    ;[L, R] = interval(b)
  }
  require(L <= R, 'No numerically valid force interval')
  const yaw = (s: number) =>
    b.reduce(
      (sum, x, i) =>
        sum + DIRECTIONS[i] * Math.min(GAMMA * (x + DIRECTIONS[i] * s), PHYSICAL.torqueCap),
      0
    )
  const knots = [L, R]
  for (let i = 0; i < 4; i++) {
    const knot = (PHYSICAL.torqueCap / GAMMA - b[i]) / DIRECTIONS[i]
    if (knot > L && knot < R) knots.push(knot)
  }
  const xs = [...new Set(knots)].sort((a, b) => a - b),
    ys = xs.map(yaw)
  for (let i = 1; i < ys.length; i++) require(ys[i] >= ys[i - 1], 'Nonmonotone numerical yaw knots')
  const limitedYaw = Math.max(ys[0], Math.min(ys.at(-1)!, ty))
  const solutions: number[] = []
  if (xs.length === 1) solutions.push(xs[0])
  for (let i = 0; i + 1 < xs.length; i++) {
    if (limitedYaw < ys[i] || limitedYaw > ys[i + 1]) continue
    if (ys[i] === ys[i + 1]) solutions.push(Math.max(xs[i], Math.min(xs[i + 1], 0)))
    else solutions.push(xs[i] + ((limitedYaw - ys[i]) * (xs[i + 1] - xs[i])) / (ys[i + 1] - ys[i]))
  }
  require(solutions.length > 0, 'Yaw inverse has no solution')
  solutions.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
  const s = solutions[0]
  const raw = b.map((v, i) => v + DIRECTIONS[i] * s)
  require(raw.every((v) => v >= -FTOL && v <= U + FTOL), 'Rotor force bound exceeded')
  const forces = raw.map((v) => Math.max(0, Math.min(U, v))),
    achieved = reconstruct(forces)
  const residuals = {
    collective: achieved.collective - F,
    moments: [
      achieved.moments[0] - tx * scale,
      achieved.moments[1] - limitedYaw,
      achieved.moments[2] - tz * scale,
    ],
  }
  require(Math.abs(residuals.collective) <= FTOL &&
    residuals.moments.every((v) => Math.abs(v) <= MTOL), 'Allocation residual exceeded')
  const targets = Object.fromEntries(
    NAMES.map((name, i) => [name, Math.sqrt(forces[i] / PHYSICAL.kt) / OMEGA_MAX])
  ) as Motors
  require(Object.values(targets).every(
    (v) => Number.isFinite(v) && v >= 0 && v <= 1
  ), 'Motor target bounds')
  return {
    requestedF,
    requestedMoments: [...requestedMoments],
    boundedF: F,
    scale,
    initialScale,
    decrements,
    yawInterval: [ys[0], ys.at(-1)!],
    limitedYaw,
    nullspace: s,
    forces,
    achieved,
    residuals,
    forceRounding: forces.map((f, i) => f - raw[i]),
    targets,
    limitations: { collective: F !== requestedF, rollPitch: scale !== 1, yaw: limitedYaw !== ty },
  }
}
/** Maximize collective while retaining all three requested steady moments. */
export function momentCollectiveCeiling(requestedF: number, moments: Vec): number {
  finite(requestedF)
  vector(moments, 3)
  require(requestedF >= 0 && requestedF <= 4 * U, 'Collective solver bound')
  const offsets = baseForces(0, moments[0], moments[2], 1)
  const capForce = PHYSICAL.torqueCap / GAMMA
  let best = -Infinity
  for (let mask = 0; mask < 16; mask++) {
    let lo = 0,
      hi = requestedF,
      feasible = true
    const constrain = (coefficient: number, rhs: number) => {
      if (coefficient > 0) hi = Math.min(hi, rhs / coefficient)
      else if (coefficient < 0) lo = Math.max(lo, rhs / coefficient)
      else if (rhs < 0) feasible = false
    }
    const lower = offsets.map((_, i) => (mask & (1 << i) ? capForce : 0))
    const upper = offsets.map((_, i) => (mask & (1 << i) ? U : capForce))
    let count = 0,
      directionSum = 0,
      constant = 0
    for (let i = 0; i < 4; i++) {
      if (mask & (1 << i)) constant += DIRECTIONS[i] * PHYSICAL.torqueCap
      else {
        count++
        directionSum += DIRECTIONS[i]
        constant += DIRECTIONS[i] * GAMMA * offsets[i]
      }
    }
    if (count > 0) {
      // The yaw equality removes s: s = beta - alpha F.
      const alpha = directionSum / (4 * count)
      const beta = (moments[1] - constant) / (GAMMA * count)
      for (let i = 0; i < 4; i++) {
        const slope = 0.25 - DIRECTIONS[i] * alpha
        const intercept = offsets[i] + DIRECTIONS[i] * beta
        constrain(slope, upper[i] - intercept)
        constrain(-slope, intercept - lower[i])
      }
    } else {
      if (moments[1] !== constant) continue
      // Constant yaw leaves a 2D region. Each lower s bound must fit every upper bound.
      const lows = offsets.map((r, i) =>
        DIRECTIONS[i] === 1 ? [-0.25, lower[i] - r] : [0.25, r - upper[i]]
      )
      const highs = offsets.map((r, i) =>
        DIRECTIONS[i] === 1 ? [-0.25, upper[i] - r] : [0.25, r - lower[i]]
      )
      for (const low of lows)
        for (const high of highs) constrain(low[0] - high[0], high[1] - low[1])
    }
    if (feasible && lo <= hi) best = Math.max(best, hi)
  }
  require(Number.isFinite(best) && best >= 0, 'Requested full moments are infeasible')
  return best
}

export function allocateAttitudeFirst(requestedF: number, moments: Vec) {
  const initial = allocate(requestedF, moments)
  const fullMoments = (a: ReturnType<typeof allocate>) =>
    a.scale === 1 && a.achieved.moments.every((v, i) => Math.abs(v - moments[i]) <= MTOL)
  if (fullMoments(initial))
    return {
      ...initial,
      policy: ALLOCATION_POLICY,
      ceiling: initial.boundedF,
      ceilingDecrements: 0,
    }
  const ceiling = momentCollectiveCeiling(initial.boundedF, moments)
  let selected = ceiling
  // Move inside a computed upper boundary by at most eight binary64 values.
  for (let attempt = 0; attempt <= 8; attempt++) {
    const result = allocate(selected, moments)
    if (fullMoments(result))
      return {
        ...result,
        requestedF,
        policy: ALLOCATION_POLICY,
        ceiling,
        ceilingDecrements: attempt,
        limitations: { ...result.limitations, collective: selected !== requestedF },
      }
    if (selected === 0) break
    selected = nextDown(selected)
  }
  throw new Error('Full-moment allocation failed its numerical postcondition')
}

export function compute(input: State, rawTarget: Target, inputConfig: ForceControllerConfig) {
  const config = ownForceControllerConfig(inputConfig)
  const state = copyPlainData(input),
    target = ownTarget(rawTarget, config)
  exactKeys(state, ['position', 'velocity', 'orientation', 'angularVelocity', 'armed'])
  const geometry = checkEnvelope(state, target)
  const alpha = geometry.error.map(
    (e, i) => -GAINS.attitudeP * e - GAINS.attitudeD * geometry.omega[i]
  ) as Vec
  const moments = alpha.map((v, i) => PHYSICAL.inertia[i] * v) as Vec
  const ay = Math.max(
    -LIMITS.verticalAccelerationMps2,
    Math.min(
      LIMITS.verticalAccelerationMps2,
      GAINS.altitudeP * (target.altitude_m - state.position[1]) -
        GAINS.altitudeD * state.velocity[1]
    )
  )
  const force = (PHYSICAL.mass * (PHYSICAL.gravity + ay)) / geometry.up[1]
  const allocation = allocateAttitudeFirst(force, moments)
  const commands = state.armed
    ? allocation.targets
    : (Object.fromEntries(NAMES.map((name) => [name, 0])) as Motors)
  return {
    profile: PROFILE,
    engineModel: ENGINE_MODEL,
    config,
    target,
    geometry,
    alpha,
    ay,
    allocation,
    commands,
    disarmed: !state.armed,
    allocation_applied: state.armed,
  }
}
