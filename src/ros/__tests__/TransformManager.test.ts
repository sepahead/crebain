import { describe, expect, it } from 'vitest'
import { TransformManager } from '../TransformManager'
import { createTime } from '../types'
import type { Point, Quaternion, TFMessage, TransformStamped } from '../types'

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 }
// 90° rotation about +Z.
const Z90: Quaternion = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }

function tf(
  parent: string,
  child: string,
  translation: [number, number, number],
  rotation: Quaternion
): TransformStamped {
  return {
    header: { stamp: createTime(), frame_id: parent },
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
function ingest(manager: TransformManager, msg: TFMessage): void {
  ;(
    manager as unknown as { handleTFMessage: (m: TFMessage, isStatic: boolean) => void }
  ).handleTFMessage(msg, true)
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
})
