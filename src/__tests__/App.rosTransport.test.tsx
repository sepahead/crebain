import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROS_SENSOR_WEBSOCKET_REQUIRED } from '../ros/useROSSensors'
import App from '../App'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  isTauri: vi.fn(() => false),
  listen: vi.fn(async () => vi.fn()),
  performancePanel: vi.fn(() => null),
  viewer: vi.fn((_props: Record<string, unknown>) => null),
  sensorFusionPanel: vi.fn((_props: Record<string, unknown>) => null),
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
vi.mock('../components/CrebainViewer', () => ({ default: mocks.viewer }))
vi.mock('../components/ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PerformancePanel', () => ({ default: mocks.performancePanel }))
vi.mock('../components/ROSConnectionPanel', () => ({
  default: () => <div data-testid="ros-connection-panel" />,
}))
vi.mock('../components/SensorFusionPanel', () => ({ default: mocks.sensorFusionPanel }))
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
  return { container, root }
}

describe('App ROS transport ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue(null)
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
    const { root } = await renderApp()

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
    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'unavailable' }),
      undefined
    )

    await act(async () => root.unmount())
  })

  it('owns one native diagnostics request and shares its resolved state', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockResolvedValue({
      platform: 'macos',
      arch: 'aarch64',
      coremlAvailable: true,
      onnxAvailable: false,
      backend: 'CoreML',
      mode: 'production',
      availableBackends: ['CoreML'],
      experimentalMlxEnabled: false,
      inferenceReady: true,
    })
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())

    const { root } = await renderApp()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('get_system_info')
    expect(mocks.viewer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        systemInfo: expect.objectContaining({ backend: 'CoreML' }),
        diagnosticsStatus: 'ready',
      }),
      undefined
    )
    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ backend: 'CoreML', status: 'ready' }),
      undefined
    )
    await act(async () => root.unmount())
  })

  it('polls an initializing runtime until diagnostics reach a terminal state', async () => {
    vi.useFakeTimers()
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke
      .mockResolvedValueOnce({
        platform: 'linux',
        arch: 'x86_64',
        backend: 'Inference Runtime Busy',
        mode: 'raw-rgba',
        inferenceReady: false,
      })
      .mockResolvedValueOnce({
        platform: 'linux',
        arch: 'x86_64',
        backend: 'Inference Runtime Busy',
        mode: 'raw-rgba',
        inferenceReady: false,
      })
      .mockResolvedValueOnce({
        platform: 'linux',
        arch: 'x86_64',
        backend: 'ONNX',
        mode: 'raw-rgba',
        availableBackends: ['ONNX'],
        inferenceReady: true,
      })
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())

    let root: Awaited<ReturnType<typeof renderApp>>['root'] | undefined
    try {
      ;({ root } = await renderApp())
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mocks.invoke).toHaveBeenCalledTimes(1)
      expect(mocks.performancePanel).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'busy' }),
        undefined
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(mocks.invoke).toHaveBeenCalledTimes(2)
      expect(mocks.performancePanel).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'busy' }),
        undefined
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(mocks.invoke).toHaveBeenCalledTimes(3)
      expect(mocks.performancePanel).toHaveBeenLastCalledWith(
        expect.objectContaining({ backend: 'ONNX', status: 'ready' }),
        undefined
      )
    } finally {
      const mountedRoot = root
      if (mountedRoot) await act(async () => mountedRoot.unmount())
      vi.useRealTimers()
    }
  })

  it('propagates detection errors and clears them after a successful sample', async () => {
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())
    const { root } = await renderApp()
    const viewerProps = mocks.viewer.mock.calls.at(-1)?.[0] as {
      onDetectionComplete: (sample: { inferenceTimeMs: number; detectionCount: number }) => void
      onDetectionError: (message: string) => void
    }

    await act(async () => viewerProps.onDetectionError('detector failed'))
    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: 'detector failed' }),
      undefined
    )

    await act(async () =>
      viewerProps.onDetectionComplete({ inferenceTimeMs: 1, detectionCount: 0 })
    )
    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: null }),
      undefined
    )

    await act(async () => root.unmount())
  })

  it('settles a failed diagnostics request as an error', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockRejectedValueOnce(new Error('IPC unavailable'))
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())

    const { root } = await renderApp()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'Backend diagnostics are unavailable',
      }),
      undefined
    )
    expect(mocks.viewer).toHaveBeenLastCalledWith(
      expect.objectContaining({ diagnosticsStatus: 'error' }),
      undefined
    )

    await act(async () => root.unmount())
  })

  it('settles a diagnostics request that never replies as an error', async () => {
    vi.useFakeTimers()
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockImplementation(() => new Promise<never>(() => undefined))
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())

    let root: Awaited<ReturnType<typeof renderApp>>['root'] | undefined
    try {
      ;({ root } = await renderApp())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })

      expect(mocks.performancePanel).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'error',
          error: 'Backend diagnostics are unavailable',
        }),
        undefined
      )
    } finally {
      const mountedRoot = root
      if (mountedRoot) await act(async () => mountedRoot.unmount())
      vi.useRealTimers()
    }
  })

  it('surfaces a detector initialization failure reported by the backend', async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockResolvedValueOnce({
      platform: 'linux',
      arch: 'x86_64',
      backend: 'No Backend Available',
      inferenceReady: false,
      inferenceInitializationError: 'Model warm-up failed',
    })
    mocks.useGazeboSimulation.mockReturnValue(gazeboReturn())

    const { root } = await renderApp()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.performancePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'unavailable',
        error: 'Model warm-up failed',
      }),
      undefined
    )

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
    const { root } = await renderApp()

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
    const { root } = await renderApp()

    expect(mocks.listen).toHaveBeenCalledWith('show-about', expect.any(Function))
    expect(mocks.invoke).toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('shows the embedded boundary and disables native access in a Tauri host frame', async () => {
    window.history.replaceState({}, '', '/?engramHost=1&hostOrigin=invalid&hostNonce=invalid')
    mocks.isTauri.mockReturnValue(true)
    const gazebo = gazeboReturn()
    const sensors = sensorReturn()
    mocks.useGazeboSimulation.mockReturnValue(gazebo)
    mocks.useROSSensors.mockReturnValue(sensors)

    try {
      const { container, root } = await renderApp()

      expect(
        container.querySelector('[data-testid="engram-embedded-boundary"]')?.textContent
      ).toContain('EMBEDDED SAFE MODE')
      expect(mocks.isTauri).not.toHaveBeenCalled()
      expect(mocks.invoke).not.toHaveBeenCalled()
      expect(mocks.listen).not.toHaveBeenCalled()
      expect(mocks.performancePanel).toHaveBeenCalledWith(
        expect.objectContaining({ initiallyExpanded: false }),
        undefined
      )
      expect(mocks.sensorFusionPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          fusionAvailable: false,
          isExpanded: false,
          onOpenConnection: undefined,
          readOnly: true,
        }),
        undefined
      )
      const fusionPanelCall = mocks.sensorFusionPanel.mock.calls.at(-1)
      expect(fusionPanelCall).toBeDefined()
      const fusionPanelProps = fusionPanelCall?.[0] as unknown as {
        onAlgorithmChange: (algorithm: 'Particle') => Promise<void>
      }
      await act(async () => fusionPanelProps.onAlgorithmChange('Particle'))
      expect(sensors.setAlgorithm).not.toHaveBeenCalled()
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
      })
      expect(container.querySelector('[data-testid="ros-connection-panel"]')).toBeNull()
      expect(gazebo.connect).not.toHaveBeenCalled()

      await act(async () => root.unmount())
    } finally {
      window.history.replaceState({}, '', '/')
    }
  })
})
