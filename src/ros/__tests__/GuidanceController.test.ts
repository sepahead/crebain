import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuidanceController } from '../GuidanceController'

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

    for (const method of [
      'publish',
      'callService',
      'publishSetpointVelocity',
      'setMode',
      'arm',
    ]) {
      expect(controller[method], method).toBeUndefined()
    }
  })
})
