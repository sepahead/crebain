import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import ROSConnectionPanel from '../ROSConnectionPanel'
import type { DroneState } from '../../hooks/useGazeboDrones'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const hostileDrone: DroneState = {
  id: 'hostile-1',
  name: 'hostile-1',
  type: 'hostile',
  status: 'airborne',
  pose: {
    position: { x: 0, y: 0, z: 10 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  },
  velocity: {
    linear: { x: 1, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: 0 },
  },
  speed: 1,
  heading: 0,
  altitude: 10,
  lastUpdate: 1,
  isArmed: false,
  mode: 'UNKNOWN',
  batteryPercent: 100,
  positionHistory: [],
}

describe('ROSConnectionPanel telemetry posture', () => {
  it('shows NoAuthority Hold and exposes no flight or mission actions', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <ROSConnectionPanel
          connectionState="disconnected"
          transport="websocket"
          onTransportChange={vi.fn()}
          rosUrl="ws://localhost:9090"
          onUrlChange={vi.fn()}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          error={null}
          drones={[hostileDrone]}
        />
      )
    })

    expect(container.textContent).toContain('NUR TELEMETRIE · NOAUTHORITY · HOLD')
    expect(container.textContent).toContain('Keine Flug-, Missions- oder Gazebo-Befehle verfügbar.')
    expect(container.textContent).not.toMatch(/ABFANGEN|ABBRUCH|EINSÄTZE/)

    await act(async () => root.unmount())
  })

  it('locks connection controls while an automatic reconnect is in progress', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onConnect = vi.fn()
    const onTransportChange = vi.fn()

    await act(async () => {
      root.render(
        <ROSConnectionPanel
          connectionState="reconnecting"
          transport="zenoh"
          onTransportChange={onTransportChange}
          rosUrl="ws://localhost:9090"
          onUrlChange={vi.fn()}
          onConnect={onConnect}
          onDisconnect={vi.fn()}
          error={null}
          drones={[]}
        />
      )
    })

    const transport = container.querySelector('select')
    const connect = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'VERBINDEN'
    )
    expect(transport?.disabled).toBe(true)
    expect(connect?.disabled).toBe(true)
    expect(connect?.getAttribute('aria-busy')).toBe('true')

    await act(async () => connect?.click())
    expect(onConnect).not.toHaveBeenCalled()
    expect(onTransportChange).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
