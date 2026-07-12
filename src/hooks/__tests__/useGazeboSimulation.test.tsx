import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  useGazeboSimulation,
  type UseGazeboSimulationConfig,
  type UseGazeboSimulationReturn,
} from '../useGazeboSimulation'
import type { DroneState } from '../useGazeboDrones'
import type { InterceptionMission, TrajectoryPoint } from '../../simulation/InterceptionSystem'
import type { Vector3 } from '../../ros/types'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  useRosBridge: vi.fn(),
  useGazeboDrones: vi.fn(),
  interceptionSystem: {
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    getInterceptor: vi.fn(),
    updateInterceptor: vi.fn(),
    registerInterceptor: vi.fn(),
    removeInterceptor: vi.fn(),
    getActiveMissions: vi.fn<() => InterceptionMission[]>(() => []),
    updateMission: vi.fn(),
    predictTargetTrajectory: vi.fn<() => TrajectoryPoint[]>(() => []),
    getGuidanceCommand: vi.fn<() => Vector3 | null>(() => null),
    assignBestInterceptor: vi.fn<() => { interceptorId: string } | null>(() => null),
    createMission: vi.fn<() => InterceptionMission | null>(() => null),
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
    mocks.useRosBridge.mockReturnValue(rosBridgeReturn())
    mocks.useGazeboDrones.mockReturnValue(gazeboDronesReturn())
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

    expect(hook.isSimulationActive).toBe(false)
    expect(hook.authority).toBe('NoAuthority')
    expect(hook.safeAction).toBe('Hold')
    expect(hook.guidancePreviews.size).toBe(0)
    expect(hook.lastGuidanceProposals.size).toBe(0)
    await hook.connect()
    hook.disconnect()
    await act(async () => {
      hook.toggleSimulation()
    })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(hook.isSimulationActive).toBe(true)

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

    await act(async () => {
      hook.toggleSimulation()
    })

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
    await act(async () => {
      hook.toggleSimulation()
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

  it('discards previews on disable/disconnect and never resurrects them after off/on', async () => {
    vi.useFakeTimers()
    const bridge = { isConnected: vi.fn(() => true) }
    const disconnect = vi.fn()
    const target = droneState('hostile_target', 'hostile')
    const interceptor = droneState('friendly_interceptor', 'friendly')
    const mission: InterceptionMission = {
      id: 'mission-preview-1',
      targetId: target.id,
      interceptorId: interceptor.id,
      strategy: 'LEAD',
      status: 'PENDING',
      startTime: Date.now(),
      interceptPoint: { x: 5, y: 0, z: 20 },
      timeToIntercept: 1,
      lastUpdate: Date.now(),
    }

    mocks.useRosBridge.mockReturnValue(
      rosBridgeReturn({ bridge, disconnect, isConnected: true, state: 'connected' })
    )
    mocks.useGazeboDrones.mockReturnValue(
      gazeboDronesReturn({
        drones: new Map([
          [target.id, target],
          [interceptor.id, interceptor],
        ]),
        hostileDrones: [target],
        friendlyDrones: [interceptor],
        getDrone: vi.fn((id: string) => (id === interceptor.id ? interceptor : undefined)),
      })
    )
    mocks.interceptionSystem.getInterceptor.mockReturnValue({ id: interceptor.id })
    mocks.interceptionSystem.assignBestInterceptor.mockReturnValue({
      interceptorId: interceptor.id,
    })
    mocks.interceptionSystem.createMission.mockReturnValue(mission)
    mocks.interceptionSystem.activateMission.mockImplementation(() => {
      mission.status = 'ACTIVE'
      return true
    })
    mocks.interceptionSystem.getActiveMissions.mockImplementation(() =>
      mission.status === 'ACTIVE' ? [mission] : []
    )
    mocks.interceptionSystem.abortMission.mockImplementation(() => {
      mission.status = 'ABORTED'
      return true
    })
    mocks.interceptionSystem.getGuidanceCommand.mockReturnValue({ x: 2, y: 0, z: 0 })
    mocks.interceptionSystem.predictTargetTrajectory.mockReturnValue([
      {
        position: { x: 11, y: 0, z: 20 },
        velocity: { x: 1, y: 0, z: 0 },
        time: 1,
      },
    ])

    const root = await renderHarness({
      enableGuidancePreview: true,
      updateIntervalMs: 50,
      guidancePreviewRateHz: 20,
    })

    await act(async () => {
      hook.toggleSimulation()
    })
    await act(async () => {
      expect(hook.initiateIntercept(target.id)).toBe(mission)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(hook.activeMissions).toHaveLength(1)
    expect(hook.guidancePreviews.size).toBe(1)
    expect(hook.trajectoryPredictions.size).toBe(1)
    expect(hook.lastGuidanceProposals.size).toBe(1)

    await act(async () => {
      root.render(
        <Harness
          tick={1}
          config={{
            enableGuidancePreview: false,
            updateIntervalMs: 50,
            guidancePreviewRateHz: 20,
          }}
        />
      )
    })

    expect(mocks.interceptionSystem.abortMission).toHaveBeenCalledWith(mission.id)
    expect(hook.activeMissions).toEqual([])
    expect(hook.guidancePreviews.size).toBe(0)
    expect(hook.trajectoryPredictions.size).toBe(0)
    expect(hook.lastGuidanceProposals.size).toBe(0)

    await act(async () => {
      hook.disconnect()
    })

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(hook.activeMissions).toEqual([])
    expect(hook.guidancePreviews.size).toBe(0)
    expect(hook.trajectoryPredictions.size).toBe(0)
    expect(hook.lastGuidanceProposals.size).toBe(0)

    await act(async () => {
      hook.toggleSimulation()
    })
    await act(async () => {
      hook.toggleSimulation()
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(hook.activeMissions).toEqual([])
    expect(hook.guidancePreviews.size).toBe(0)
    expect(hook.trajectoryPredictions.size).toBe(0)
    expect(hook.lastGuidanceProposals.size).toBe(0)

    await act(async () => root.unmount())
  })
})
