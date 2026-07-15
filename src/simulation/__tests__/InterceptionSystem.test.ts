import { afterEach, describe, expect, it, vi } from 'vitest'
import { InterceptionSystem, MAX_TRAJECTORY_POINTS } from '../InterceptionSystem'

function createSystem() {
  const system = new InterceptionSystem()
  system.registerInterceptor(
    'interceptor-1',
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { maxSpeed: 20 }
  )
  system.registerInterceptor(
    'interceptor-2',
    { x: 100, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { maxSpeed: 20 }
  )
  system.updateTarget('target-1', { x: 40, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
  return system
}

describe('InterceptionSystem', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('predicts target positions and trajectories deterministically', () => {
    const system = createSystem()

    expect(system.predictTargetPosition('target-1', 5)).toEqual({ x: 45, y: 0, z: 0 })
    expect(system.predictTargetTrajectory('target-1', 1, 0.5)).toEqual([
      { position: { x: 40, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, time: 0 },
      { position: { x: 40.5, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, time: 0.5 },
      { position: { x: 41, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, time: 1 },
    ])
    expect(system.predictTargetPosition('missing', 5)).toBeNull()
    expect(system.predictTargetTrajectory('missing', 1)).toEqual([])
  })

  it('rejects invalid or unbounded trajectory allocations before sampling', () => {
    const system = createSystem()

    for (const [duration, step] of [
      [0, 0.5],
      [1, 0],
      [Number.NaN, 0.5],
      [1, Number.POSITIVE_INFINITY],
      [Number.POSITIVE_INFINITY, 0.5],
      [1, Number.MIN_VALUE],
    ]) {
      expect(system.predictTargetTrajectory('target-1', duration, step)).toEqual([])
    }

    const atBound = system.predictTargetTrajectory('target-1', MAX_TRAJECTORY_POINTS - 1, 1)
    expect(atBound).toHaveLength(MAX_TRAJECTORY_POINTS)
    expect(atBound.at(-1)?.time).toBe(MAX_TRAJECTORY_POINTS - 1)
    expect(system.predictTargetTrajectory('target-1', MAX_TRAJECTORY_POINTS, 1)).toEqual([])
  })

  it('creates, activates, updates, and completes missions', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const system = createSystem()
    const mission = system.createMission('interceptor-1', 'target-1', 'LEAD')

    expect(mission).toEqual(
      expect.objectContaining({
        id: 'mission_1',
        interceptorId: 'interceptor-1',
        targetId: 'target-1',
        strategy: 'LEAD',
        status: 'PENDING',
        startTime: 1_000,
      })
    )
    expect(system.createMission('interceptor-1', 'target-1')).toBeNull()
    expect(system.activateMission(mission!.id)).toBe(true)
    expect(system.getActiveMissions().map((active) => active.id)).toEqual([mission!.id])

    system.updateInterceptor('interceptor-1', { x: 39, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(system.updateMission(mission!.id)).toEqual(
      expect.objectContaining({ status: 'COMPLETED' })
    )
    expect(system.getAvailableInterceptors().map((interceptor) => interceptor.id)).toContain(
      'interceptor-1'
    )
  })

  it('assigns the closest viable interceptor and provides guidance commands', () => {
    const system = createSystem()

    const assignment = system.assignBestInterceptor('target-1')
    expect(assignment?.interceptorId).toBe('interceptor-1')
    expect(assignment?.result.isPossible).toBe(true)

    const mission = system.createMission(
      assignment!.interceptorId,
      'target-1',
      assignment!.result.strategy
    )
    system.activateMission(mission!.id)

    const guidance = system.getGuidanceCommand('interceptor-1')
    expect(guidance).toEqual(expect.objectContaining({ y: 0, z: 0 }))
    expect(Math.hypot(guidance!.x, guidance!.y, guidance!.z)).toBeLessThanOrEqual(20)
  })

  it('aborts and releases pending and active missions when their target is removed', () => {
    const system = createSystem()
    const pendingMission = system.createMission('interceptor-1', 'target-1', 'LEAD')!
    const activeMission = system.createMission('interceptor-2', 'target-1', 'LEAD')!
    system.activateMission(activeMission.id)

    expect(system.getAvailableInterceptors()).toEqual([])
    system.removeTarget('target-1')

    expect(system.getMission(pendingMission.id)).toEqual(
      expect.objectContaining({ status: 'ABORTED' })
    )
    expect(system.getMission(activeMission.id)).toEqual(
      expect.objectContaining({ status: 'ABORTED' })
    )
    expect(
      system
        .getAvailableInterceptors()
        .map((interceptor) => interceptor.id)
        .sort()
    ).toEqual(['interceptor-1', 'interceptor-2'])
    expect(system.getGuidanceCommand('interceptor-1')).toBeNull()
    expect(system.getGuidanceCommand('interceptor-2')).toBeNull()
  })

  it('aborts only a live matching reservation and preserves terminal mission history', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const system = createSystem()
    const completed = system.createMission('interceptor-1', 'target-1', 'LEAD')!
    system.activateMission(completed.id)
    system.updateInterceptor('interceptor-1', { x: 40, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    system.updateMission(completed.id)

    const newer = system.createMission('interceptor-1', 'target-1', 'LEAD')!
    expect(system.abortMission(completed.id)).toBe(false)
    expect(completed.status).toBe('COMPLETED')
    expect(system.getInterceptor('interceptor-1')?.currentMission?.id).toBe(newer.id)

    vi.setSystemTime(2_000)
    expect(system.abortMission(newer.id)).toBe(true)
    expect(newer).toMatchObject({ status: 'ABORTED', lastUpdate: 2_000 })
    expect(system.getInterceptor('interceptor-1')?.currentMission).toBeNull()

    vi.setSystemTime(3_000)
    expect(system.abortMission(newer.id)).toBe(false)
    expect(newer.lastUpdate).toBe(2_000)
  })

  it('closes the along-track gap for PARALLEL intercepts', () => {
    const system = new InterceptionSystem()
    system.registerInterceptor(
      'interceptor-1',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { maxSpeed: 20 }
    )
    // Target offset both along its heading (x) and perpendicular to it (z).
    system.updateTarget('target-1', { x: 30, y: 0, z: 40 }, { x: 5, y: 0, z: 0 })

    const result = system.calculateIntercept('interceptor-1', 'target-1', 'PARALLEL')

    expect(result.isPossible).toBe(true)
    expect(Number.isFinite(result.timeToIntercept)).toBe(true)
    const speed = Math.hypot(
      result.interceptorVelocity.x,
      result.interceptorVelocity.y,
      result.interceptorVelocity.z
    )
    expect(speed).toBeCloseTo(20, 6)

    // Flying the commanded velocity for timeToIntercept must land on the
    // intercept point, which is where the target will be at that time; a
    // purely perpendicular command would never close the along-track gap.
    const t = result.timeToIntercept
    expect(result.interceptorVelocity.x * t).toBeCloseTo(result.interceptPoint.x, 6)
    expect(result.interceptorVelocity.y * t).toBeCloseTo(result.interceptPoint.y, 6)
    expect(result.interceptorVelocity.z * t).toBeCloseTo(result.interceptPoint.z, 6)
    expect(result.interceptPoint.x).toBeCloseTo(30 + 5 * t, 6)
    expect(result.interceptPoint.y).toBeCloseTo(0, 6)
    expect(result.interceptPoint.z).toBeCloseTo(40, 6)
  })

  it('returns immediate-intercept guidance when the interceptor is on the target (LEAD)', () => {
    const system = new InterceptionSystem()
    system.registerInterceptor(
      'interceptor-1',
      { x: 5, y: 5, z: 5 },
      { x: 0, y: 0, z: 0 },
      { maxSpeed: 20 }
    )
    system.updateTarget('target-1', { x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 })

    const result = system.calculateIntercept('interceptor-1', 'target-1', 'LEAD')

    expect(result.isPossible).toBe(true)
    expect(result.timeToIntercept).toBe(0)
    expect(result.interceptorVelocity).toEqual({ x: 0, y: 0, z: 0 })
    expect(Number.isFinite(result.interceptPoint.x)).toBe(true)
    expect(Number.isFinite(result.interceptPoint.y)).toBe(true)
    expect(Number.isFinite(result.interceptPoint.z)).toBe(true)
  })

  it('reports impossible intercepts for missing participants and unavailable targets', () => {
    const system = createSystem()

    expect(system.calculateIntercept('missing', 'target-1')).toEqual(
      expect.objectContaining({
        isPossible: false,
        reason: 'Interceptor not found',
      })
    )
    expect(system.calculateIntercept('interceptor-1', 'missing')).toEqual(
      expect.objectContaining({
        isPossible: false,
        reason: 'Target not found',
      })
    )
    expect(system.assignBestInterceptor('missing')).toBeNull()
  })
})
