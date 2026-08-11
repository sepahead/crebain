import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuidanceController, MAX_GUIDANCE_RATE_HZ } from '../GuidanceController'

describe('GuidanceController local preview', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts inactive and accepts no transport capability', () => {
    const controller = createGuidanceController()

    expect(controller.isActive()).toBe(false)
    controller.startPreview()

    expect(controller.isActive()).toBe(true)
    expect(controller.getState().lastProposedVelocity).toEqual({ x: 0, y: 0, z: 0 })
    controller.stop()
  })

  it('ramps direct velocity proposals with explicit no-authority metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const controller = createGuidanceController({
      rateHz: 10,
      maxAcceleration: 10,
      maxVelocity: 5,
    })
    const callback = vi.fn()
    controller.onProposal(callback)

    controller.startPreview()
    controller.setPreviewVelocity({ x: 10, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)

    expect(callback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authority: 'NoAuthority',
        action: 'PreviewVelocity',
        velocity: expect.objectContaining({ x: 1, y: 0, z: 0 }),
      })
    )
    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authority: 'NoAuthority',
        action: 'PreviewVelocity',
        velocity: expect.objectContaining({ x: 2, y: 0, z: 0 }),
      })
    )

    controller.stop()
  })

  it('proposes Hold when the target is within the arrival threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const controller = createGuidanceController({ rateHz: 10, arrivalThreshold: 0.5 })
    const callback = vi.fn()
    controller.onProposal(callback)

    controller.startPreview()
    controller.updateCurrentPosition({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    controller.setTargetPosition({ x: 0.25, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(100)

    expect(callback).toHaveBeenCalledWith({
      authority: 'NoAuthority',
      action: 'Hold',
      velocity: { x: 0, y: 0, z: 0 },
      distanceToTarget: 0.25,
      estimatedTimeToArrival: 0,
    })

    controller.stop()
  })

  it('holds immediately and only notifies local subscribers', () => {
    const controller = createGuidanceController()
    const callback = vi.fn()
    controller.onProposal(callback)

    controller.startPreview()
    controller.updateCurrentPosition({ x: 0, y: 0, z: 10 }, { x: 4, y: 0, z: 0 })
    controller.setPreviewVelocity({ x: 4, y: 0, z: 0 })
    controller.hold()

    expect(callback).toHaveBeenCalledWith({
      authority: 'NoAuthority',
      action: 'Hold',
      velocity: { x: 0, y: 0, z: 0 },
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    })

    controller.stop()
  })

  it('does not accelerate away from zero when the wall clock moves backwards', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const controller = createGuidanceController({
      rateHz: 10,
      maxAcceleration: 10,
      maxVelocity: 5,
    })
    const callback = vi.fn()
    controller.onProposal(callback)

    controller.startPreview()
    controller.setPreviewVelocity({ x: 5, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({ velocity: { x: 1, y: 0, z: 0 } })
    )

    controller.clearTarget()
    vi.setSystemTime(2_000)
    ;(controller as unknown as { update: () => void }).update()

    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'PreviewVelocity',
        velocity: { x: 1, y: 0, z: 0 },
      })
    )

    controller.stop()
  })

  it('uses PreviewVelocity while decelerating and reserves Hold for exact zero', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000)
    const controller = createGuidanceController({
      rateHz: 10,
      maxAcceleration: 5,
      maxVelocity: 5,
    })
    const callback = vi.fn()
    controller.onProposal(callback)

    controller.startPreview()
    controller.setPreviewVelocity({ x: 5, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(200)
    controller.clearTarget()
    await vi.advanceTimersByTimeAsync(100)

    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'PreviewVelocity',
        velocity: { x: 0.5, y: 0, z: 0 },
      })
    )

    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenLastCalledWith({
      authority: 'NoAuthority',
      action: 'Hold',
      velocity: { x: 0, y: 0, z: 0 },
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    })

    controller.stop()
  })

  it('exposes no transport write methods', () => {
    const controller = createGuidanceController() as unknown as Record<string, unknown>

    for (const method of ['publish', 'callService', 'publishSetpointVelocity', 'setMode', 'arm']) {
      expect(controller[method], method).toBeUndefined()
    }
  })

  it('rejects unsafe timer and control configuration atomically', () => {
    expect(() => createGuidanceController({ rateHz: 0 })).toThrow('Guidance rateHz')
    expect(() => createGuidanceController({ rateHz: MAX_GUIDANCE_RATE_HZ + 1 })).toThrow(
      'Guidance rateHz'
    )
    expect(() => createGuidanceController({ maxAcceleration: Number.POSITIVE_INFINITY })).toThrow(
      'Guidance maxAcceleration'
    )

    const controller = createGuidanceController()
    const before = controller.getConfig()
    expect(() => controller.setConfig({ arrivalThreshold: before.approachDistance + 1 })).toThrow(
      'must not exceed approachDistance'
    )
    expect(controller.getConfig()).toEqual(before)
  })

  it('snapshots vector inputs and state outputs', () => {
    const controller = createGuidanceController()
    const target = { x: 1, y: 2, z: 3 }
    const current = { x: 4, y: 5, z: 6 }
    controller.setTargetPosition(target)
    controller.updateCurrentPosition(current, { x: 0, y: 0, z: 0 })

    target.x = 99
    current.x = 99
    const firstSnapshot = controller.getState()
    expect(firstSnapshot.targetPosition).toEqual({ x: 1, y: 2, z: 3 })
    expect(firstSnapshot.currentPosition).toEqual({ x: 4, y: 5, z: 6 })

    firstSnapshot.currentPosition.x = -1
    expect(controller.getCurrentPosition()).toEqual({ x: 4, y: 5, z: 6 })
    expect(() => controller.setPreviewVelocity({ x: Number.NaN, y: 0, z: 0 })).toThrow(
      'must contain finite coordinates'
    )
  })

  it('isolates proposal observers from each other and from controller state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const controller = createGuidanceController({ rateHz: 10, maxAcceleration: 10 })
    controller.onProposal((proposal) => {
      proposal.velocity.x = 999
    })
    const second = vi.fn()
    controller.onProposal(second)
    controller.startPreview()
    controller.setPreviewVelocity({ x: 5, y: 0, z: 0 })

    await vi.advanceTimersByTimeAsync(100)

    expect(second).toHaveBeenCalledWith(expect.objectContaining({ velocity: { x: 1, y: 0, z: 0 } }))
    expect(controller.getState().lastProposedVelocity).toEqual({ x: 1, y: 0, z: 0 })
    controller.stop()
  })
})
