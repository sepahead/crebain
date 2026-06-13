import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { FusionStats } from '../../../detection/SensorFusion'
import type { Detection, FusedTrack } from '../../../detection/types'
import type { SurveillanceCamera } from '../types'
import HeaderBar from '../HeaderBar'
import DetectionPanel from '../DetectionPanel'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Render smoke tests for the extracted viewer panels. These automate the
 * "diagnostics / detection overlay renders" rows of docs/MANUAL_SMOKE_TEST.md:
 * the panels are pure presentational React (no WebGL), so they mount cleanly in
 * happy-dom and we assert the load-bearing readouts appear.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HeaderBar render smoke', () => {
  it('mounts and shows branding, position, and live counters without crashing', () => {
    act(() => {
      root.render(
        <HeaderBar
          backendStatusColor="bg-[#3a6b4a]"
          threatLevel={2}
          onThreatLevelChange={() => {}}
          scalePercent={100}
          isAtMin={false}
          isAtMax={false}
          onDecreaseScale={() => {}}
          onIncreaseScale={() => {}}
          currentTime={new Date(0)}
          operatorPosition={{ lat: 52.52, lon: 13.405, alt: 34 }}
          altitude={12}
          bearing={90}
          cameras={[]}
          objectCount={0}
          totalDetections={0}
          fusedTrackCount={0}
          showGrid
          detectionEnabled
          highestThreat={null}
        />
      )
    })

    const text = container.textContent ?? ''
    expect(text).toContain('CREBAIN')
    expect(text).toContain('SIM POS')
    // The threat-level selector renders buttons 1-4.
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(4)
  })
})

describe('DetectionPanel render smoke', () => {
  const track = {
    id: 'TRK-001',
    class: 'drone',
    threatLevel: 3,
    state: 'confirmed',
    fusedConfidence: 0.87,
    contributingCameras: ['SK-001', 'SK-002'],
  } as unknown as FusedTrack

  const detection = {
    id: 'DET-001',
    class: 'drone',
    confidence: 0.91,
    threatLevel: 3,
  } as unknown as Detection

  const cameras = [{ id: 'SK-001', name: 'NORD' } as unknown as SurveillanceCamera]
  const fusionStats = {
    frameCount: 12,
    avgFusedConfidence: 0.8,
    highThreatCount: 1,
  } as unknown as FusionStats

  it('renders fused tracks, camera detections, and fusion stats', () => {
    act(() => {
      root.render(
        <DetectionPanel
          totalDetections={1}
          fusedTracks={[track]}
          cameraDetections={new Map([['SK-001', [detection]]])}
          cameras={cameras}
          fusionStats={fusionStats}
          onClose={() => {}}
        />
      )
    })

    const text = container.textContent ?? ''
    expect(text).toContain('TRK-001')
    expect(text).toContain('BESTÄTIGTE TRACKS')
    expect(text).toContain('KAMERA DETEKTIONEN')
    expect(text).toContain('NORD')
  })

  it('invokes onClose when the close button is clicked', () => {
    let closed = false
    act(() => {
      root.render(
        <DetectionPanel
          totalDetections={0}
          fusedTracks={[track]}
          cameraDetections={new Map()}
          cameras={[]}
          fusionStats={null}
          onClose={() => {
            closed = true
          }}
        />
      )
    })

    const closeButton = container.querySelector('button')
    expect(closeButton).not.toBeNull()
    act(() => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(closed).toBe(true)
  })
})
