import { describe, expect, it } from 'vitest'
import { TransformManager } from '../TransformManager'
import { createTime } from '../types'
import type { Point, Quaternion, TFMessage, Time, Transform, TransformStamped } from '../types'
import {
  MAX_TF_TRANSLATION_METERS,
  TF_QUATERNION_NORM_TOLERANCE,
} from '../tfValidation'

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 }
// 90° rotation about +Z.
const Z90: Quaternion = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }

function tf(
  parent: string,
  child: string,
  translation: [number, number, number],
  rotation: Quaternion,
  timestamp?: number | Time
): TransformStamped {
  return {
    header: {
      stamp:
        timestamp === undefined
          ? createTime()
          : typeof timestamp === 'number'
            ? createTime(new Date(timestamp))
            : timestamp,
      frame_id: parent,
    },
    child_frame_id: child,
    transform: {
      translation: { x: translation[0], y: translation[1], z: translation[2] },
      rotation,
    },
  }
}

// The manager has no public transform-insertion API (transforms normally arrive
// over /tf); reach the package-private ingest point with a precisely typed cast
// (no `any`).
function ingest(manager: TransformManager, msg: TFMessage, isStatic = true): void {
  ;(
    manager as unknown as { handleTFMessage: (m: TFMessage, isStatic: boolean) => void }
  ).handleTFMessage(msg, isStatic)
}

function requirePoint(point: Point | null): Point {
  if (!point) throw new Error('expected a valid transform result')
  return point
}

function expectClose(a: Point, b: Point, eps = 1e-6): void {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps)
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps)
  expect(Math.abs(a.z - b.z)).toBeLessThan(eps)
}

function buildTree(): TransformManager {
  // world -> odom -> base_link, with a non-trivial rotation on the second hop.
  const manager = new TransformManager()
  ingest(manager, {
    transforms: [tf('world', 'odom', [10, 0, 0], IDENTITY), tf('odom', 'base_link', [0, 5, 0], Z90)],
  })
  return manager
}

describe('TransformManager multi-hop chains', () => {
  it('two-hop lookup equals composing the two verified single hops', () => {
    const manager = buildTree()
    const pBase: Point = { x: 1, y: 2, z: 3 }

    // Reference: the single-hop direct lookups are the known-correct path.
    const pOdom = requirePoint(manager.transformPoint(pBase, 'odom', 'base_link'))
    const pWorldRef = requirePoint(manager.transformPoint(pOdom, 'world', 'odom'))

    // Under test: no direct world<-base_link transform exists, so this exercises
    // the frame-tree chain. The old code returned the inverse transform here.
    const pWorldChain = requirePoint(manager.transformPoint(pBase, 'world', 'base_link'))

    expectClose(pWorldChain, pWorldRef)
  })

  it('down-chain is the inverse of the up-chain (round-trips to identity)', () => {
    const manager = buildTree()
    const pBase: Point = { x: 1, y: 2, z: 3 }

    const pWorld = requirePoint(manager.transformPoint(pBase, 'world', 'base_link'))
    const back = requirePoint(manager.transformPoint(pWorld, 'base_link', 'world'))

    expectClose(back, pBase)
  })

  it('evaluates every dynamic edge at the latest shared instant', () => {
    const manager = new TransformManager()
    ingest(
      manager,
      {
        transforms: [
          // Deliberately out of arrival order to prove the cache is indexed by
          // ROS stamp rather than receive order.
          tf('world', 'odom', [20, 0, 0], IDENTITY, 3_000),
          tf('world', 'odom', [0, 0, 0], IDENTITY, 1_000),
          tf('odom', 'base_link', [0, 0, 0], IDENTITY, 2_000),
          tf('odom', 'base_link', [0, 20, 0], IDENTITY, 4_000),
        ],
      },
      false
    )

    const lookup = manager.lookupTransform('world', 'base_link')

    expect(lookup.valid).toBe(true)
    expectClose(lookup.transform.translation, { x: 20, y: 10, z: 0 })
    expect(lookup.timestamp).toEqual({ secs: 3, nsecs: 0 })
  })

  it('interpolates all dynamic links at one explicitly requested time', () => {
    const manager = new TransformManager()
    ingest(
      manager,
      {
        transforms: [
          tf('world', 'odom', [0, 0, 0], IDENTITY, 1_000),
          tf('world', 'odom', [20, 0, 0], IDENTITY, 3_000),
          tf('odom', 'base_link', [0, 0, 0], IDENTITY, 2_000),
          tf('odom', 'base_link', [0, 20, 0], IDENTITY, 4_000),
        ],
      },
      false
    )

    const requestedTime = createTime(new Date(2_500))
    const lookup = manager.lookupTransform('world', 'base_link', requestedTime)

    expect(lookup.valid).toBe(true)
    expectClose(lookup.transform.translation, { x: 15, y: 5, z: 0 })
    expect(lookup.timestamp).toEqual(requestedTime)
  })

  it('keeps distinct sub-millisecond ROS stamps coherent across a chain', () => {
    const manager = new TransformManager()
    const early = { secs: 1, nsecs: 100 }
    const late = { secs: 1, nsecs: 900 }
    ingest(
      manager,
      {
        transforms: [
          tf('world', 'odom', [0, 0, 0], IDENTITY, early),
          tf('world', 'odom', [8, 0, 0], IDENTITY, late),
          tf('odom', 'base_link', [0, 0, 0], IDENTITY, early),
          tf('odom', 'base_link', [0, 16, 0], IDENTITY, late),
        ],
      },
      false
    )

    const requestedTime = { secs: 1, nsecs: 500 }
    const lookup = manager.lookupTransform('world', 'base_link', requestedTime)

    expect(lookup.valid).toBe(true)
    expectClose(lookup.transform.translation, { x: 4, y: 8, z: 0 })
    expect(lookup.timestamp).toEqual(requestedTime)
  })

  it('refuses direct extrapolation outside a dynamic edge history', () => {
    const manager = new TransformManager()
    ingest(
      manager,
      {
        transforms: [
          tf('world', 'base_link', [0, 0, 0], IDENTITY, 1_000),
          tf('world', 'base_link', [10, 0, 0], IDENTITY, 2_000),
        ],
      },
      false
    )

    expect(
      manager.lookupTransform('world', 'base_link', createTime(new Date(500)))
    ).toMatchObject({
      valid: false,
      error: expect.stringContaining('extrapolation is disabled'),
    })
    expect(manager.lookupTransform('world', 'base_link', createTime(new Date(2_500))).valid).toBe(
      false
    )
  })

  it('refuses a dynamic chain whose histories have no common instant', () => {
    const manager = new TransformManager()
    ingest(
      manager,
      {
        transforms: [
          tf('world', 'odom', [0, 0, 0], IDENTITY, 1_000),
          tf('world', 'odom', [1, 0, 0], IDENTITY, 2_000),
          tf('odom', 'base_link', [0, 0, 0], IDENTITY, 3_000),
          tf('odom', 'base_link', [0, 1, 0], IDENTITY, 4_000),
        ],
      },
      false
    )

    expect(manager.lookupTransform('world', 'base_link').valid).toBe(false)
  })

  it('rejects invalid ingress transforms and normalizes accepted rounding drift', () => {
    const manager = new TransformManager()
    ingest(manager, {
      transforms: [
        tf('', 'empty-parent', [0, 0, 0], IDENTITY),
        tf('world', '', [0, 0, 0], IDENTITY),
        tf('world', 'zero-quaternion', [0, 0, 0], { x: 0, y: 0, z: 0, w: 0 }),
        tf('world', 'non-unit', [0, 0, 0], { x: 0, y: 0, z: 0, w: 0.5 }),
        tf('world', 'unbounded', [MAX_TF_TRANSLATION_METERS + 1, 0, 0], IDENTITY),
        tf(
          'world',
          'normalized',
          [1, 0, 0],
          { x: 0, y: 0, z: 0, w: 1 + TF_QUATERNION_NORM_TOLERANCE / 2 }
        ),
      ],
    })

    expect(manager.getCacheStats()).toEqual({
      dynamicTransforms: 0,
      staticTransforms: 1,
      knownFrames: 2,
    })
    expect(manager.lookupTransform('', '').valid).toBe(false)
    const accepted = manager.lookupTransform('world', 'normalized')
    expect(accepted.valid).toBe(true)
    expect(Math.hypot(...Object.values(accepted.transform.rotation))).toBeCloseTo(1, 12)
  })

  it('fails closed when an extreme multi-hop composition exceeds the transform bound', () => {
    const manager = new TransformManager()
    const edge = MAX_TF_TRANSLATION_METERS * 0.4
    ingest(manager, {
      transforms: [
        tf('world', 'hop-1', [edge, 0, 0], IDENTITY),
        tf('hop-1', 'hop-2', [edge, 0, 0], IDENTITY),
        tf('hop-2', 'hop-3', [edge, 0, 0], IDENTITY),
      ],
    })

    expect(manager.lookupTransform('world', 'hop-3')).toMatchObject({
      valid: false,
      error: expect.stringContaining('No temporally coherent transform'),
    })
  })

  it('rejects nonfinite composition and transformed-point results', () => {
    const manager = new TransformManager()
    const compose = (
      manager as unknown as {
        composeTransforms: (left: Transform, right: Transform) => Transform | null
      }
    ).composeTransforms.bind(manager)
    const extreme: Transform = {
      translation: { x: Number.MAX_VALUE, y: 0, z: 0 },
      rotation: IDENTITY,
    }

    expect(compose(extreme, extreme)).toBeNull()
    expect(
      manager.transformPoint(
        { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
        'world',
        'world'
      )
    ).toBeNull()
  })
})
