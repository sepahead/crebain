// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DronePhysicsWorld } from '../DronePhysics'
import {
  DeterministicDroneWorld,
  DYNAMICS_PROFILE,
  SCENE_DYNAMICS_PROFILE,
  type DynamicsPlan,
} from '../DeterministicDroneWorld'
import { ownStaticGeometry, prepareStaticGeometry, type StaticCuboid } from '../StaticGeometry'

const roof = (): StaticCuboid => ({
  id: 'building-a',
  center: [0, 3, 0],
  halfExtents: [2, 1, 2],
  yaw: 0,
  friction: 0.5,
  restitution: 0,
})
const plan = (): DynamicsPlan => ({
  profile: SCENE_DYNAMICS_PROFILE,
  runId: 'city-control',
  sourceIdentity: 'b'.repeat(64),
  capabilities: ['dynamics', 'attitude_controller'],
  seed: 3,
  geometry: 'static-cuboids-v1',
  staticGeometry: [roof()],
  drones: [{ id: 'drone-a', position: [0, 7, 0] }],
})

async function state(owner: DeterministicDroneWorld): Promise<string> {
  const handle = await owner.checkpoint()
  const result = owner.checkpointState(handle)
  owner.releaseCheckpoint(handle)
  return result
}

describe('project-owned static scene geometry', () => {
  it('collides with the actual building and preserves the independent ground-only control', async () => {
    const input = plan()
    const city = await DeterministicDroneWorld.prepare(input)
    const ground = await DeterministicDroneWorld.prepare({
      ...input,
      profile: DYNAMICS_PROFILE,
      geometry: 'ground-cuboid-v1',
      ...{ staticGeometry: undefined },
    } as unknown as DynamicsPlan).catch(() => null)
    // A scene-only field cannot enter the old closed profile, even when undefined.
    expect(ground).toBeNull()
    const { staticGeometry: _geometry, ...old } = input as Extract<
      DynamicsPlan,
      { profile: typeof SCENE_DYNAMICS_PROFILE }
    >
    const empty = await DeterministicDroneWorld.prepare({
      ...old,
      profile: DYNAMICS_PROFILE,
      geometry: 'ground-cuboid-v1',
    })
    try {
      city.advance(360)
      empty.advance(360)
      expect(city.observe().profile).toBe(SCENE_DYNAMICS_PROFILE)
      expect(city.observe().drones[0].position[1]).toBeCloseTo(4.05, 1)
      expect(empty.observe().drones[0].position[1]).toBeCloseTo(0.05, 1)
      expect(JSON.parse(await state(city)).physics.staticGeometry).toEqual([roof()])
    } finally {
      city.retire()
      empty.retire()
    }
  })

  it('reconstructs all future collision state and keeps branch geometry immutable', async () => {
    const input = plan()
    const canonical = await DeterministicDroneWorld.prepare(input)
    if (input.profile === SCENE_DYNAMICS_PROFILE) input.staticGeometry[0].center[1] = 100
    canonical.advance(24)
    const checkpoint = await canonical.checkpoint()
    const a = await canonical.fork(checkpoint)
    const b = await canonical.fork(checkpoint)
    try {
      b.advance(720)
      a.advance(720)
      canonical.advance(720)
      expect(await state(a)).toBe(await state(b))
      expect(await state(a)).toBe(await state(canonical))
      expect(a.observe().drones[0].position[1]).toBeCloseTo(4.05, 1)
      await canonical.restore(checkpoint)
      canonical.advance(720)
      expect(await state(canonical)).toBe(await state(a))
    } finally {
      a.retire()
      b.retire()
      canonical.retire()
    }
  })

  it('rejects altered geometry, accessors, over-budget input, and forged handles before initialization', () => {
    expect(ownStaticGeometry([])).toEqual([])
    expect(ownStaticGeometry([roof()])).toEqual([roof()])
    const read = vi.fn(() => [0, 0, 0])
    const accessor = {
      ...roof(),
      get center() {
        return read()
      },
    }
    expect(() => ownStaticGeometry([accessor] as StaticCuboid[])).toThrow('accessors')
    expect(read).not.toHaveBeenCalled()
    expect(() => ownStaticGeometry([{ ...roof(), halfExtents: [1, -1, 1] }])).toThrow('shape')
    expect(() => ownStaticGeometry([{ ...roof(), center: [0, Infinity, 0] }])).toThrow('vectors')
    expect(() => ownStaticGeometry(Array.from({ length: 65 }, roof))).toThrow('count')
    expect(() => ownStaticGeometry([roof(), roof()])).toThrow('unique')
    expect(
      () => new DronePhysicsWorld('explicit', { profile: 'crebain.static-cuboids.v1' })
    ).toThrow('unrecognized')
    const handle = prepareStaticGeometry([roof()])
    expect(() => new DronePhysicsWorld('wall', handle)).toThrow('explicit')
    const admitted = new DronePhysicsWorld('explicit', handle)
    admitted.destroy()
  })
})
