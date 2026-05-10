import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useGazeboSimulation, type UseGazeboSimulationConfig, type UseGazeboSimulationReturn } from '../useGazeboSimulation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  useRosBridge: vi.fn(),
  useGazeboDrones: vi.fn(),
  getGazeboController: vi.fn(),
  gazeboController: {
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

vi.mock('../useRosBridge', () => ({
  useRosBridge: mocks.useRosBridge,
}))

vi.mock('../useGazeboDrones', () => ({
  useGazeboDrones: mocks.useGazeboDrones,
}))

vi.mock('../../ros/GazeboController', () => ({
  getGazeboController: mocks.getGazeboController,
}))

let hook: UseGazeboSimulationReturn

function Harness({ config, tick = 0 }: { config?: Partial<UseGazeboSimulationConfig>; tick?: number }) {
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
    mocks.getGazeboController.mockReturnValue(mocks.gazeboController)
    mocks.useRosBridge.mockReturnValue(rosBridgeReturn())
    mocks.useGazeboDrones.mockReturnValue(gazeboDronesReturn())
  })

  it('connects and disconnects the Gazebo controller from ROS bridge state', async () => {
    let connected = false
    const bridge = { isConnected: vi.fn(() => connected) }
    mocks.useRosBridge.mockImplementation(() => rosBridgeReturn({
      bridge,
      isConnected: connected,
      state: connected ? 'connected' : 'disconnected',
    }))
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

    expect(mocks.useRosBridge).toHaveBeenLastCalledWith(expect.objectContaining({
      transport: 'zenoh',
      url: 'ws://initial:9090',
      autoConnect: false,
    }))

    await act(async () => {
      hook.setTransport('websocket')
      hook.setRosUrl('ws://updated:9090')
    })

    expect(mocks.useRosBridge).toHaveBeenLastCalledWith(expect.objectContaining({
      transport: 'websocket',
      url: 'ws://updated:9090',
    }))

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
})
