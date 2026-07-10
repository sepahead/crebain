import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  useGazeboSimulation,
  type UseGazeboSimulationConfig,
  type UseGazeboSimulationReturn,
} from '../useGazeboSimulation'
import type { DroneState } from '../useGazeboDrones'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  useRosBridge: vi.fn(),
  useGazeboDrones: vi.fn(),
  getGazeboController: vi.fn(),
  gazeboController: {
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
  interceptionSystem: {
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    getInterceptor: vi.fn(),
    updateInterceptor: vi.fn(),
    registerInterceptor: vi.fn(),
    removeInterceptor: vi.fn(),
    getActiveMissions: vi.fn(() => []),
    updateMission: vi.fn(),
    predictTargetTrajectory: vi.fn(() => []),
    getGuidanceCommand: vi.fn(() => null),
    assignBestInterceptor: vi.fn(() => null),
    createMission: vi.fn(() => null),
    activateMission: vi.fn(() => false),
    abortMission: vi.fn(() => false),
  },
}))

vi.mock('../useRosBridge', () => ({
  useRosBridge: mocks.useRosBridge,
}))

vi.mock('../useGazeboDrones', () => ({
  GAZEBO_DRONE_STALE_MS: 5000,
  useGazeboDrones: mocks.useGazeboDrones,
}))

vi.mock('../../ros/GazeboController', () => ({
  getGazeboController: mocks.getGazeboController,
}))

vi.mock('../../simulation/InterceptionSystem', () => ({
  getInterceptionSystem: () => mocks.interceptionSystem,
}))

let hook: UseGazeboSimulationReturn

function Harness({
  config,
  tick = 0,
}: {
  config?: Partial<UseGazeboSimulationConfig>
  tick?: number
}) {
  void tick
  hook = useGazeboSimulation(config)
  return null
}

function rosBridgeReturn(overrides: Record<string, unknown> = {}) {
  return {
    state: 'disconnected',
    isConnected: false,
    error: null,
    bridge: null,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    publish: vi.fn(),
    callService: vi.fn(),
    performance: { quality: null, topicStats: [], alerts: [] },
    recordMessage: vi.fn(),
    ...overrides,
  }
}

function gazeboDronesReturn(overrides: Record<string, unknown> = {}) {
  return {
    drones: new Map(),
    friendlyDrones: [],
    hostileDrones: [],
    unknownDrones: [],
    getDrone: vi.fn(),
    getClosestHostile: vi.fn(),
    predictPosition: vi.fn(),
    ...overrides,
  }
}

function droneState(
  id: string,
  type: DroneState['type'],
  lastUpdate: number = Date.now()
): DroneState {
  return {
    id,
    name: id,
    type,
    status: 'airborne',
    pose: {
      position: { x: 10, y: 0, z: 20 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    velocity: {
      linear: { x: 1, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    },
    speed: 1,
    heading: 0,
    altitude: 20,
    lastUpdate,
    isArmed: true,
    mode: 'OFFBOARD',
    batteryPercent: 90,
    positionHistory: [],
  }
}

async function renderHarness(config?: Partial<UseGazeboSimulationConfig>) {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness config={config} />)
  })
  return root
}

describe('useGazeboSimulation', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.interceptionSystem.getInterceptor.mockReset()
    mocks.interceptionSystem.getActiveMissions.mockReset().mockReturnValue([])
    mocks.interceptionSystem.predictTargetTrajectory.mockReset().mockReturnValue([])
    mocks.interceptionSystem.getGuidanceCommand.mockReset().mockReturnValue(null)
    mocks.interceptionSystem.assignBestInterceptor.mockReset().mockReturnValue(null)
    mocks.interceptionSystem.createMission.mockReset().mockReturnValue(null)
    mocks.interceptionSystem.activateMission.mockReset().mockReturnValue(false)
    mocks.interceptionSystem.abortMission.mockReset().mockReturnValue(false)
    mocks.getGazeboController.mockReturnValue(mocks.gazeboController)
    mocks.useRosBridge.mockReturnValue(rosBridgeReturn())
    mocks.useGazeboDrones.mockReturnValue(gazeboDronesReturn())
  })

  it('connects and disconnects the Gazebo controller from ROS bridge state', async () => {
    let connected = false
    const bridge = { isConnected: vi.fn(() => connected) }
    mocks.useRosBridge.mockImplementation(() =>
      rosBridgeReturn({
        bridge,
        isConnected: connected,
        state: connected ? 'connected' : 'disconnected',
      })
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness tick={0} />)
    })
    expect(mocks.gazeboController.disconnect).toHaveBeenCalledTimes(1)

    connected = true
    await act(async () => {
      root.render(<Harness tick={1} />)
    })
    expect(mocks.gazeboController.connect).toHaveBeenCalledWith(bridge)

    connected = false
    await act(async () => {
      root.render(<Harness tick={2} />)
    })
    expect(mocks.gazeboController.disconnect).toHaveBeenCalledTimes(2)

    await act(async () => root.unmount())
  })

  it('passes transport and URL state into useRosBridge', async () => {
    const root = await renderHarness({ transport: 'zenoh', rosUrl: 'ws://initial:9090' })

    expect(mocks.useRosBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transport: 'zenoh',
        url: 'ws://initial:9090',
        autoConnect: false,
      })
    )

    await act(async () => {
      hook.setTransport('websocket')
      hook.setRosUrl('ws://updated:9090')
    })

    expect(mocks.useRosBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transport: 'websocket',
        url: 'ws://updated:9090',
      })
    )

    await act(async () => root.unmount())
  })

  it('defaults to WebSocket and exposes the active bridge for shared consumers', async () => {
    const bridge = { isConnected: vi.fn(() => false) }
    mocks.useRosBridge.mockReturnValue(rosBridgeReturn({ bridge }))
    const root = await renderHarness()

    expect(mocks.useRosBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ transport: 'websocket' })
    )
    expect(hook.bridge).toBe(bridge)

    await act(async () => root.unmount())
  })

  it('exposes connection delegates and simulation toggles', async () => {
    const connect = vi.fn(async () => undefined)
    const disconnect = vi.fn()
    mocks.useRosBridge.mockReturnValue(rosBridgeReturn({ connect, disconnect }))
    const root = await renderHarness()

    expect(hook.isSimulationActive).toBe(true)
    await hook.connect()
    hook.disconnect()
    await act(async () => {
      hook.toggleSimulation()
    })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(hook.isSimulationActive).toBe(false)

    await act(async () => root.unmount())
  })

  it('removes targets and interceptors that disappear from the active drone snapshot', async () => {
    const bridge = { isConnected: vi.fn(() => true) }
    const targetOne = droneState('hostile_target_1', 'hostile')
    const targetTwo = droneState('hostile_target_2', 'hostile')
    const interceptorOne = droneState('friendly_interceptor_1', 'friendly')
    const interceptorTwo = droneState('friendly_interceptor_2', 'friendly')
    mocks.useRosBridge.mockReturnValue(
      rosBridgeReturn({ bridge, isConnected: true, state: 'connected' })
    )
    mocks.useGazeboDrones.mockReturnValue(
      gazeboDronesReturn({
        drones: new Map([
          [targetOne.id, targetOne],
          [targetTwo.id, targetTwo],
          [interceptorOne.id, interceptorOne],
          [interceptorTwo.id, interceptorTwo],
        ]),
        hostileDrones: [targetOne, targetTwo],
        friendlyDrones: [interceptorOne, interceptorTwo],
      })
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness tick={0} />)
    })

    mocks.useGazeboDrones.mockReturnValue(
      gazeboDronesReturn({
        drones: new Map([
          [targetTwo.id, targetTwo],
          [interceptorTwo.id, interceptorTwo],
        ]),
        hostileDrones: [targetTwo],
        friendlyDrones: [interceptorTwo],
      })
    )
    await act(async () => {
      root.render(<Harness tick={1} />)
    })

    expect(mocks.interceptionSystem.removeTarget).toHaveBeenCalledWith(targetOne.id)
    expect(mocks.interceptionSystem.removeTarget).not.toHaveBeenCalledWith(targetTwo.id)
    expect(mocks.interceptionSystem.removeInterceptor).toHaveBeenCalledWith(interceptorOne.id)
    expect(mocks.interceptionSystem.removeInterceptor).not.toHaveBeenCalledWith(interceptorTwo.id)

    await act(async () => root.unmount())
  })

  it('rejects intercept requests while disconnected', async () => {
    const target = droneState('hostile_target', 'hostile')
    mocks.useGazeboDrones.mockReturnValue(
      gazeboDronesReturn({
        drones: new Map([[target.id, target]]),
        hostileDrones: [target],
      })
    )
    const root = await renderHarness()

    expect(hook.initiateIntercept(target.id)).toBeNull()
    expect(mocks.interceptionSystem.assignBestInterceptor).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('rejects intercept requests for missing and stale targets', async () => {
    const bridge = { isConnected: vi.fn(() => true) }
    mocks.useRosBridge.mockReturnValue(
      rosBridgeReturn({ bridge, isConnected: true, state: 'connected' })
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Harness tick={0} />)
    })
    expect(hook.initiateIntercept('missing_target')).toBeNull()

    const staleTarget = droneState('stale_target', 'hostile', Date.now() - 5_001)
    mocks.useGazeboDrones.mockReturnValue(
      gazeboDronesReturn({
        drones: new Map([[staleTarget.id, staleTarget]]),
        hostileDrones: [staleTarget],
      })
    )
    await act(async () => {
      root.render(<Harness tick={1} />)
    })

    expect(hook.initiateIntercept(staleTarget.id)).toBeNull()
    expect(mocks.interceptionSystem.assignBestInterceptor).not.toHaveBeenCalled()
    expect(mocks.interceptionSystem.updateTarget).not.toHaveBeenCalledWith(
      staleTarget.id,
      expect.anything(),
      expect.anything()
    )

    await act(async () => root.unmount())
  })
})
