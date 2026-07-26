import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SensorFusionPanel from '../SensorFusionPanel'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getAlgorithms: vi.fn(async () => [
    { id: 'ExtendedKalman', name: 'EKF', description: 'Extended Kalman' },
    { id: 'Particle', name: 'PF', description: 'Particle' },
  ]),
}))

vi.mock('../../detection/AdvancedSensorFusion', () => ({
  getAlgorithms: mocks.getAlgorithms,
  formatAlgorithmName: (algorithm: string) => algorithm,
  formatModality: (modality: string) => modality,
  getThreatColor: () => '#808080',
  getTrackStateColor: () => '#808080',
}))

vi.mock('../../hooks/useDraggablePanel', () => ({
  useDraggablePanel: ({ onHeaderClick }: { onHeaderClick?: () => void }) => ({
    panelStyle: {},
    handleMouseDown: vi.fn(),
    handleHeaderClick: onHeaderClick,
    elementRef: { current: null },
  }),
}))

const sensorStatus = {
  thermal: false,
  acoustic: false,
  radar: false,
  lidar: false,
  visual: false,
  radiofrequency: false,
}

let root: Root
let container: HTMLDivElement

async function renderPanel(
  readOnly: boolean,
  onAlgorithmChange = vi.fn(async () => undefined),
  onOpenConnection = vi.fn()
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <SensorFusionPanel
        readOnly={readOnly}
        tracks={[]}
        stats={null}
        sensorStatus={sensorStatus}
        isExpanded
        connectionState="disconnected"
        onOpenConnection={onOpenConnection}
        algorithm="ExtendedKalman"
        onAlgorithmChange={onAlgorithmChange}
        fusionAvailable
      />
    )
  })
  return { onAlgorithmChange, onOpenConnection }
}

describe('SensorFusionPanel hosted read-only policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
  })

  it('removes connection and algorithm mutation affordances in read-only mode', async () => {
    const callbacks = await renderPanel(true)

    expect(container.querySelector('[data-read-only]')?.getAttribute('data-read-only')).toBe('true')
    expect(container.querySelector('[aria-label="Fusion-Einstellungen öffnen"]')).toBeNull()
    expect(container.textContent).not.toContain('VERBINDUNG ÖFFNEN')
    expect(mocks.getAlgorithms).not.toHaveBeenCalled()
    expect(callbacks.onAlgorithmChange).not.toHaveBeenCalled()
    expect(callbacks.onOpenConnection).not.toHaveBeenCalled()
  })

  it('preserves standalone connection and algorithm controls', async () => {
    const callbacks = await renderPanel(false)

    expect(container.querySelector('[data-read-only]')?.getAttribute('data-read-only')).toBe(
      'false'
    )
    expect(container.textContent).toContain('VERBINDUNG ÖFFNEN')
    expect(mocks.getAlgorithms).toHaveBeenCalledTimes(1)

    const settings = container.querySelector<HTMLButtonElement>(
      '[aria-label="Fusion-Einstellungen öffnen"]'
    )
    await act(async () => settings?.click())
    const particle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Particle'
    )
    await act(async () => particle?.click())

    expect(callbacks.onAlgorithmChange).toHaveBeenCalledWith('Particle')
  })
})
