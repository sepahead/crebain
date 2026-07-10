import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROS_SENSOR_WEBSOCKET_REQUIRED } from '../ros/useROSSensors'
import App from '../App'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => null),
  isTauri: vi.fn(() => false),
  listen: vi.fn(async () => vi.fn()),
  useGazeboSimulation: vi.fn(),
  useROSSensors: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../hooks/useGazeboSimulation', () => ({
  useGazeboSimulation: mocks.useGazeboSimulation,
}))
vi.mock('../ros/useROSSensors', () => ({
  ROS_SENSOR_WEBSOCKET_REQUIRED:
    'Custom ROS sensor fusion topics require the WebSocket transport. Switch the ROS transport to WebSocket to enable them.',
  useROSSensors: mocks.useROSSensors,
}))
vi.mock('../hooks/usePerformanceTracker', () => ({
  usePerformanceTracker: () => ({
    currentData: null,
    history: [],
    recordSample: vi.fn(),
  }),
}))
vi.mock('../components/CrebainViewer', () => ({ default: () => null }))
vi.mock('../components/ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PerformancePanel', () => ({ default: () => null }))
vi.mock('../components/ROSConnectionPanel', () => ({ default: () => null }))
vi.mock('../components/SensorFusionPanel', () => ({ default: () => null }))
vi.mock('../components/AboutModal', () => ({ AboutModal: () => null }))
vi.mock('../context/UIScaleContext', () => ({
  UIScaleProvider: ({ children }: { children: ReactNode }) => children,
}))

function gazeboReturn(overrides: Record<string, unknown> = {}) {
  return {
    connectionState: 'disconnected',
    bridge: null,
    transport: 'websocket',
    setTransport: vi.fn(),
    rosUrl: 'ws://localhost:9090',
    setRosUrl: vi.fn(),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    connectionError: null,
    allDrones: [],
    activeMissions: [],
    initiateIntercept: vi.fn(),
    abortMission: vi.fn(),
    ...overrides,
  }
}

function sensorReturn() {
  return {
    connectionState: 'disconnected',
    connectionError: null,
    fusionStats: null,
    tracks: [],
    sensorStatus: {
      thermal: false,
      acoustic: false,
      radar: false,
      lidar: false,
      visual: false,
      radiofrequency: false,
    },
    lastUpdateMs: 0,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    setAlgorithm: vi.fn(async () => undefined),
    clearAllTracks: vi.fn(async () => undefined),
    addVisualDetection: vi.fn(),
  }
}

async function renderApp() {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  return root
}

describe('App ROS transport ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauri.mockReturnValue(false)
    mocks.useROSSensors.mockReturnValue(sensorReturn())
  })

  it('passes the visible WebSocket bridge to sensor fusion', async () => {
    const bridge = { subscribe: vi.fn() }
    mocks.useGazeboSimulation.mockReturnValue(
      gazeboReturn({
        bridge,
        transport: 'websocket',
        connectionState: 'connected',
      })
    )
    const root = await renderApp()

    expect(mocks.useROSSensors).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalConnection: {
          bridge,
          connectionState: 'connected',
          connectionError: null,
        },
      })
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.listen).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('does not create a sensor WebSocket when Zenoh is selected', async () => {
    mocks.useGazeboSimulation.mockReturnValue(
      gazeboReturn({
        bridge: { subscribe: vi.fn() },
        transport: 'zenoh',
        connectionState: 'connected',
      })
    )
    const root = await renderApp()

    expect(mocks.useROSSensors).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalConnection: {
          bridge: null,
          connectionState: 'disconnected',
          unsupportedReason: ROS_SENSOR_WEBSOCKET_REQUIRED,
        },
      })
    )

    await act(async () => root.unmount())
  })

  it('handles native menu-listener setup failures without an unhandled rejection', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.listen.mockRejectedValueOnce(new Error('menu unavailable'))
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())
    const root = await renderApp()

    expect(mocks.listen).toHaveBeenCalledWith('show-about', expect.any(Function))
    expect(mocks.invoke).toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
