import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MANAGED_DRONES, useDroneController } from '../useDroneController'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  constructed: vi.fn(),
  created: vi.fn(),
  destroyed: vi.fn(),
  initialized: vi.fn(async () => undefined),
  removed: vi.fn(),
  removeFailures: new Set<string>(),
  resetTime: vi.fn(),
}))

vi.mock('../../physics/DronePhysics', () => ({
  DronePhysicsWorld: class {
    private readonly drones = new Map<string, unknown>()

    constructor() {
      mocks.constructed()
    }

    init = mocks.initialized
    destroy = mocks.destroyed
    resetTime = mocks.resetTime

    createDrone(id: string, params: unknown, position: THREE.Vector3, mesh?: THREE.Object3D) {
      const targetCommands = {
        front_left: 0,
        front_right: 0,
        rear_left: 0,
        rear_right: 0,
      }
      const state = {
        position: position.clone(),
        velocity: new THREE.Vector3(),
        acceleration: new THREE.Vector3(),
        orientation: new THREE.Quaternion(),
        angularVelocity: new THREE.Vector3(),
        rotors: [],
        battery: 1,
        armed: false,
      }
      const body = {
        id,
        params,
        mesh: mesh ?? null,
        rigidBody: {
          setTranslation: vi.fn(),
          setRotation: vi.fn(),
          setLinvel: vi.fn(),
          setAngvel: vi.fn(),
        },
        state,
        targetCommands,
        setMotorCommands: vi.fn((commands: typeof targetCommands) => {
          Object.assign(targetCommands, commands)
        }),
        setArmed: vi.fn((armed: boolean) => {
          state.armed = armed
        }),
      }
      this.drones.set(id, body)
      mocks.created(id)
      return body
    }

    removeDrone(id: string) {
      if (mocks.removeFailures.has(id)) throw new Error(`remove failed for ${id}`)
      this.drones.delete(id)
      mocks.removed(id)
    }

    getDrone(id: string) {
      return this.drones.get(id)
    }
  },
  FlightController: class {},
}))

vi.mock('../../integrations/engramHost', () => ({
  isEngramEmbeddedMode: () => true,
}))

let controller: ReturnType<typeof useDroneController>
let testScene: THREE.Scene

function Harness({
  enabled,
  onDroneStateChange,
}: {
  enabled: boolean
  onDroneStateChange?: () => void
}) {
  controller = useDroneController({ scene: testScene, enabled, onDroneStateChange })
  return null
}

describe('useDroneController lifecycle authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.removeFailures.clear()
    testScene = new THREE.Scene()
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

  it('publishes an inert state after an enabled controller is disabled', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    await act(async () => {
      await controller.spawnDrone('maverick')
      controller.setSimulationPaused(false)
    })
    expect(controller.physicsReady).toBe(true)
    expect(controller.drones).toHaveLength(1)
    expect(controller.isPaused).toBe(false)

    await act(async () => root.render(<Harness enabled={false} />))

    expect(controller.physicsReady).toBe(false)
    expect(controller.drones).toEqual([])
    expect(controller.selectedDroneId).toBeNull()
    expect(controller.isPaused).toBe(true)
    expect(mocks.destroyed).toHaveBeenCalledTimes(1)
    expect(mocks.removed).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    expect(mocks.destroyed).toHaveBeenCalledTimes(1)
  })

  it('restores a suspended drone graph with its identity and dynamic state', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick', 'ROLLBACK-UAV', new THREE.Vector3(1, 2, 3))
    })
    expect(id).not.toBeNull()
    const original = controller.drones[0]
    original.physicsBody.state.velocity.set(4, 5, 6)
    original.physicsBody.state.angularVelocity.set(0.1, 0.2, 0.3)
    original.physicsBody.state.battery = 0.42

    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })
    expect(controller.drones).toEqual([])
    expect(controller.isPaused).toBe(true)
    expect(suspension!.state).toBe('suspended')

    await act(async () => controller.restoreSuspendedDrones(suspension!))
    expect(suspension!.state).toBe('restored')
    expect(controller.drones).toHaveLength(1)
    expect(controller.drones[0].id).toBe(id)
    expect(controller.drones[0].mesh).toBe(original.mesh)
    expect(controller.drones[0].physicsBody.state.velocity.toArray()).toEqual([4, 5, 6])
    expect(controller.drones[0].physicsBody.state.angularVelocity.toArray()).toEqual([
      0.1, 0.2, 0.3,
    ])
    expect(controller.drones[0].physicsBody.state.battery).toBe(0.42)
    expect(controller.selectedDroneId).toBe(id)
    expect(() => controller.restoreSuspendedDrones(suspension!)).toThrow('already restored')

    await act(async () => root.unmount())
  })

  it('reclaims a retained physics body when suspension reports a detach failure', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick', 'RETAINED-UAV', new THREE.Vector3(1, 2, 3))
    })
    expect(id).not.toBeNull()
    const originalBody = controller.drones[0].physicsBody
    mocks.removeFailures.add(id!)

    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })
    expect(suspension!.errors).toHaveLength(1)
    mocks.removeFailures.clear()

    await act(async () => controller.restoreSuspendedDrones(suspension!))

    expect(controller.drones).toHaveLength(1)
    expect(controller.drones[0].physicsBody).toBe(originalBody)
    expect(mocks.created).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('reclaims a retained physics body before disposing a suspended graph', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick', 'RETIRED-UAV', new THREE.Vector3(1, 2, 3))
    })
    expect(id).not.toBeNull()
    mocks.removeFailures.add(id!)

    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })
    expect(suspension!.errors).toHaveLength(1)
    expect(mocks.removed).not.toHaveBeenCalledWith(id)

    mocks.removeFailures.clear()
    await act(async () => controller.disposeSuspendedDrones(suspension!))

    expect(suspension!.state).toBe('disposed')
    expect(mocks.removed).toHaveBeenCalledWith(id)
    await act(async () => root.unmount())
  })

  it('keeps a suspended token retryable when retained-body cleanup fails', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick', 'RETRY-UAV', new THREE.Vector3(1, 2, 3))
    })
    mocks.removeFailures.add(id!)
    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })

    expect(controller.disposeSuspendedDrones(suspension!)).toBe(false)
    expect(suspension!.state).toBe('suspended')
    mocks.removeFailures.clear()
    expect(controller.disposeSuspendedDrones(suspension!)).toBe(true)
    expect(suspension!.state).toBe('disposed')

    await act(async () => root.unmount())
  })

  it('keeps a drone registered when a scene event reattaches its mesh during removal', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))
    await act(async () => {
      await controller.spawnDrone('maverick')
    })
    const drone = controller.drones[0]
    expect(drone.mesh).not.toBeNull()
    const reattach = () => {
      testScene.add(drone.mesh!)
      throw new Error('synthetic removal listener failure')
    }
    drone.mesh!.addEventListener('removed', reattach)

    await act(async () => controller.removeDrone(drone.id))

    expect(controller.drones).toHaveLength(1)
    expect(controller.drones[0]).toBe(drone)
    expect(drone.mesh!.parent).toBe(testScene)

    drone.mesh!.removeEventListener('removed', reattach)
    await act(async () => controller.removeDrone(drone.id))
    expect(controller.drones).toEqual([])

    await act(async () => root.unmount())
  })

  it('retains a suspended snapshot until an attached mesh can be detached', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))
    await act(async () => {
      await controller.spawnDrone('maverick')
    })
    const drone = controller.drones[0]
    const reattach = () => {
      testScene.add(drone.mesh!)
      throw new Error('synthetic removal listener failure')
    }
    drone.mesh!.addEventListener('removed', reattach)

    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })
    expect(suspension!.errors.length).toBeGreaterThan(0)
    expect(controller.disposeSuspendedDrones(suspension!)).toBe(false)
    expect(suspension!.state).toBe('suspended')

    drone.mesh!.removeEventListener('removed', reattach)
    expect(controller.disposeSuspendedDrones(suspension!)).toBe(true)
    expect(suspension!.state).toBe('disposed')

    await act(async () => root.unmount())
  })

  it('classifies a thrown added listener by the resulting scene ownership', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))
    await act(async () => {
      await controller.spawnDrone('maverick')
    })
    const drone = controller.drones[0]
    let suspension: ReturnType<typeof controller.suspendDronesForSceneRestore>
    await act(async () => {
      suspension = controller.suspendDronesForSceneRestore()
    })
    const failAfterAttach = () => {
      throw new Error('synthetic added listener failure')
    }
    drone.mesh!.addEventListener('added', failAfterAttach)

    await act(async () => controller.restoreSuspendedDrones(suspension!))

    expect(suspension!.state).toBe('restored')
    expect(controller.drones).toHaveLength(1)
    expect(drone.mesh!.parent).toBe(testScene)

    drone.mesh!.removeEventListener('added', failAfterAttach)
    await act(async () => root.unmount())
  })

  it('does not let a throwing observer roll back an owned drone', async () => {
    const observer = vi.fn(() => {
      throw new Error('synthetic observer failure')
    })
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled onDroneStateChange={observer} />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick')
    })

    expect(id).not.toBeNull()
    expect(controller.drones).toHaveLength(1)
    expect(controller.drones[0].mesh?.parent).toBe(testScene)
    expect(observer).toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('rejects invalid identity text before allocating a model or physics body', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))
    const initialCreateCount = mocks.created.mock.calls.length

    await expect(controller.spawnDrone('maverick', '')).resolves.toBeNull()
    await expect(
      controller.spawnDrone('maverick', 'VALID', undefined, { id: `bad\0id` })
    ).resolves.toBeNull()
    await expect(controller.spawnDrone('maverick', '€'.repeat(86))).resolves.toBeNull()

    expect(mocks.created).toHaveBeenCalledTimes(initialCreateCount)
    expect(controller.drones).toEqual([])
    await act(async () => root.unmount())
  })

  it('accounts pending spawns against the managed-drone ceiling', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let results: Array<string | null> = []
    await act(async () => {
      results = await Promise.all(
        Array.from({ length: MAX_MANAGED_DRONES + 1 }, (_, index) =>
          controller.spawnDrone('maverick', `UAV-${index}`, undefined, { id: `cap-${index}` })
        )
      )
    })

    expect(results.filter((id) => id !== null)).toHaveLength(MAX_MANAGED_DRONES)
    expect(results.at(-1)).toBeNull()
    expect(controller.drones).toHaveLength(MAX_MANAGED_DRONES)

    await act(async () => root.unmount())
  })

  it('rejects malformed route state without mutating the live drone', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Harness enabled />))

    let id: string | null = null
    await act(async () => {
      id = await controller.spawnDrone('maverick')
    })
    expect(id).not.toBeNull()

    const waypoint = {
      position: new THREE.Vector3(1, 2, 3),
      altitude: 2,
    }
    const originalRoute = controller.drones[0].route

    expect(controller.setRoute(id!, null as never, 'once')).toBe(false)
    expect(controller.setRoute(id!, [waypoint], 'invalid' as never)).toBe(false)
    expect(
      controller.setRoute(id!, [waypoint], 'once', {
        currentWaypointIndex: 1,
      })
    ).toBe(false)
    expect(
      controller.setRoute(id!, [], 'none', {
        isActive: true,
      })
    ).toBe(false)
    expect(controller.drones[0].route).toBe(originalRoute)

    expect(controller.setRoute(id!, [waypoint], 'once')).toBe(true)
    waypoint.position.set(Number.NaN, 2, 3)
    expect(controller.drones[0].route.waypoints[0].position.toArray()).toEqual([1, 2, 3])

    await act(async () => root.unmount())
  })
})
