import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  setTransport: vi.fn(),
  useGazeboSimulation: vi.fn(),
  useROSSensors: vi.fn(),
}))

vi.mock('#renderer-rosbridge', () => ({ RENDERER_ROSBRIDGE_AVAILABLE: false }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
  isTauri: vi.fn(() => false),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }))
vi.mock('../hooks/useGazeboSimulation', () => ({
  useGazeboSimulation: mocks.useGazeboSimulation,
}))
vi.mock('../ros/useROSSensors', () => ({
  ROS_SENSOR_WEBSOCKET_REQUIRED: 'development websocket required',
  useROSSensors: mocks.useROSSensors,
}))
vi.mock('../hooks/usePerformanceTracker', () => ({
  usePerformanceTracker: () => ({ currentData: null, history: [], recordSample: vi.fn() }),
}))
vi.mock('../components/CrebainViewer', () => ({
  default: ({
    rosConnectionState,
    rosTransport,
  }: {
    rosConnectionState: string
    rosTransport: string
  }) => (
    <div
      data-testid="viewer-ros-status"
      data-connection-state={rosConnectionState}
      data-transport={rosTransport}
    />
  ),
}))
vi.mock('../components/ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PerformancePanel', () => ({ default: () => null }))
vi.mock('../components/AboutModal', () => ({ AboutModal: () => null }))
vi.mock('../context/UIScaleContext', () => ({
  UIScaleProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/ROSConnectionPanel', () => ({
  default: ({ transport }: { transport: string }) => (
    <div data-testid="production-transport">{transport}</div>
  ),
}))
vi.mock('../components/SensorFusionPanel', () => ({
  default: ({ onOpenConnection }: { onOpenConnection?: () => void }) => (
    <button data-testid="open-production-connection" onClick={onOpenConnection}>
      Open connection
    </button>
  ),
}))

import App from '../App'

describe('App packaged ROS transport policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useGazeboSimulation.mockReturnValue({
      connectionState: 'disconnected',
      bridge: { subscribe: vi.fn() },
      transport: 'zenoh',
      setTransport: mocks.setTransport,
      rosUrl: 'ws://localhost:9090',
      setRosUrl: vi.fn(),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      connectionError: null,
      allDrones: [],
    })
    mocks.useROSSensors.mockReturnValue({
      connectionState: 'disconnected',
      connectionError: null,
      fusionError: null,
      fusionAvailable: true,
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
      setAlgorithm: vi.fn(async () => undefined),
      addVisualDetection: vi.fn(),
    })
  })

  it('keeps Zenoh selected when the fusion panel opens the packaged connection UI', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<App />))

    expect(mocks.useROSSensors).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalConnection: expect.objectContaining({
          bridge: null,
          connectionState: 'disconnected',
          unsupportedReason: expect.stringContaining('Vite development profile'),
        }),
      })
    )

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="open-production-connection"]'
    )
    expect(open).not.toBeNull()
    await act(async () => open?.click())

    expect(mocks.setTransport).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="production-transport"]')?.textContent).toBe(
      'zenoh'
    )
    const viewerStatus = container.querySelector('[data-testid="viewer-ros-status"]')
    expect(viewerStatus?.getAttribute('data-connection-state')).toBe('disconnected')
    expect(viewerStatus?.getAttribute('data-transport')).toBe('zenoh')

    await act(async () => root.unmount())
  })
})
