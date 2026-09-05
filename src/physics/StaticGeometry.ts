import { copyPlainData } from '../lib/copyPlainData'

/** Meter-scale fixed cuboid, rotated about the Three.js world +Y axis. */
export interface StaticCuboid {
  id: string
  center: [number, number, number]
  halfExtents: [number, number, number]
  yaw: number
  friction: number
  restitution: number
}

export const MAX_STATIC_CUBOIDS = 64
export interface StaticGeometryHandle {
  readonly profile: 'crebain.static-cuboids.v1'
}
const admittedGeometry = new WeakMap<StaticGeometryHandle, StaticCuboid[]>()

/** Admit one immutable value before any physics or graphics allocation. */
export function ownStaticGeometry(input: StaticCuboid[]): StaticCuboid[] {
  const result = copyPlainData(input)
  if (!Array.isArray(result) || result.length > MAX_STATIC_CUBOIDS)
    throw new Error('Static geometry count exceeds the operating envelope')
  let previous = ''
  for (const row of result) {
    if (
      !row ||
      Object.keys(row).sort().join('|') !== 'center|friction|halfExtents|id|restitution|yaw' ||
      typeof row.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) ||
      row.id <= previous
    )
      throw new Error('Static geometry requires closed sorted unique cuboids')
    previous = row.id
    for (const values of [row.center, row.halfExtents]) {
      if (
        !Array.isArray(values) ||
        values.length !== 3 ||
        values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1000)
      )
        throw new Error('Static geometry requires bounded meter-scale vectors')
    }
    if (
      row.halfExtents.some((value) => value < 0.01 || value > 100) ||
      !Number.isFinite(row.yaw) ||
      Math.abs(row.yaw) > Math.PI ||
      !Number.isFinite(row.friction) ||
      row.friction < 0 ||
      row.friction > 2 ||
      !Number.isFinite(row.restitution) ||
      row.restitution < 0 ||
      row.restitution > 1
    )
      throw new Error('Static geometry material or shape exceeds the operating envelope')
  }
  return result
}

/** An opaque same-runtime handle to validated immutable geometry. */
export function prepareStaticGeometry(input: StaticCuboid[]): StaticGeometryHandle {
  const geometry = ownStaticGeometry(input)
  const handle = Object.freeze({ profile: 'crebain.static-cuboids.v1' as const })
  admittedGeometry.set(handle, geometry)
  return handle
}

export function staticGeometryData(handle: StaticGeometryHandle): StaticCuboid[] {
  const data = admittedGeometry.get(handle)
  if (!data) throw new Error('Static geometry handle is unrecognized')
  return data
}
