import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDroneController } from '../useDroneController'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  constructed: vi.fn(),
  destroyed: vi.fn(),
  initialized: vi.fn(async () => undefined),
}))

vi.mock('../../physics/DronePhysics', () => ({
  DronePhysicsWorld: class {
    constructor() {
      mocks.constructed()
    }

    init = mocks.initialized
    destroy = mocks.destroyed
    resetTime = vi.fn()
  },
  FlightController: class {},
}))

vi.mock('../../integrations/engramHost', () => ({
  isEngramEmbeddedMode: () => true,
}))

let controller: ReturnType<typeof useDroneController>

function Harness({ enabled }: { enabled: boolean }) {
  controller = useDroneController({ scene: new THREE.Scene(), enabled })
  return null
}

describe('useDroneController lifecycle authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not initialize a physics world when the controller is disabled', async () => {
    const root = createRoot(document.createElement('div'))

    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.constructed).not.toHaveBeenCalled()
    expect(mocks.initialized).not.toHaveBeenCalled()
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    await act(async () => {
      controller.togglePause()
      controller.setSimulationPaused(false)
      controller.resetSimulation()
      await controller.spawnDrone('maverick')
    })
    expect(controller.isPaused).toBe(true)
    expect(mocks.constructed).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    expect(mocks.destroyed).not.toHaveBeenCalled()
  })

  it('preserves standalone physics initialization when the controller is enabled', async () => {
    const root = createRoot(document.createElement('div'))

    await act(async () => root.render(<Harness enabled />))

    expect(mocks.constructed).toHaveBeenCalledTimes(1)
    expect(mocks.initialized).toHaveBeenCalledTimes(1)

    await act(async () => controller.togglePause())
    expect(controller.isPaused).toBe(false)

    await act(async () => root.unmount())
    expect(mocks.destroyed).toHaveBeenCalledTimes(1)
  })
})
