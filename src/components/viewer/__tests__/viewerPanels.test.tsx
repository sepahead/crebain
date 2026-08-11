import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { FusionStats } from '../../../detection/SensorFusion'
import type { Detection, FusedTrack } from '../../../detection/types'
import type { SurveillanceCamera } from '../types'
import HeaderBar from '../HeaderBar'
import {
  DEFAULT_SECURITY_CONFIGURATION_STATUS,
  getSecurityConfigurationPresentation,
} from '../securityConfigurationStatus'
import DetectionPanel from '../DetectionPanel'
import { ViewerFooter, ViewerOverlayRail } from '../ViewerChrome'
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
  it('defaults an unattested deployment to a neutral unknown security state', () => {
    expect(DEFAULT_SECURITY_CONFIGURATION_STATUS).toBe('unknown')
    expect(getSecurityConfigurationPresentation(DEFAULT_SECURITY_CONFIGURATION_STATUS)).toEqual(
      expect.objectContaining({ label: 'UNBEKANNT', color: 'bg-[#404040]' })
    )
  })

  it('mounts and shows branding, position, and live counters without crashing', () => {
    act(() => {
      root.render(
        <HeaderBar
          backendStatusColor="bg-[#3a6b4a]"
          securityConfigurationStatus="unknown"
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
    expect(
      (container.querySelector('[aria-label="Primary status and controls"]') as HTMLElement)
        .tabIndex
    ).toBe(0)
    expect(
      (container.querySelector('[aria-label="Detection and sensor status"]') as HTMLElement)
        .tabIndex
    ).toBe(0)
    expect(
      container.querySelector('[aria-label="Set threat level 2"]')?.getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      container.querySelector('[aria-label="Set threat level 1"]')?.getAttribute('aria-pressed')
    ).toBe('false')

    const primaryRegion = container.querySelector(
      '[aria-label="Primary status and controls"]'
    ) as HTMLElement
    Object.defineProperties(primaryRegion, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 1000 },
    })
    primaryRegion.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }))
    expect(primaryRegion.scrollLeft).toBe(600)
    primaryRegion.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }))
    expect(primaryRegion.scrollLeft).toBe(0)
  })

  it('renders threat level as status instead of mutation controls in read-only mode', () => {
    const onThreatLevelChange = vi.fn()
    act(() => {
      root.render(
        <HeaderBar
          backendStatusColor="bg-[#3a6b4a]"
          securityConfigurationStatus="unknown"
          readOnly
          threatLevel={2}
          onThreatLevelChange={onThreatLevelChange}
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
          detectionEnabled={false}
          highestThreat={null}
        />
      )
    })

    expect(container.querySelector('[aria-label="Threat level 2, current"]')).not.toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        ['1', '2', '3', '4'].includes(button.textContent ?? '')
      )
    ).toBe(false)
    expect(onThreatLevelChange).not.toHaveBeenCalled()
  })

  it.each([
    {
      status: 'not-configured' as const,
      visibleLabel: 'NICHT KONFIG.',
      accessibleStatus: 'not configured',
      neutralColor: 'bg-[#505050]',
    },
    {
      status: 'unknown' as const,
      visibleLabel: 'UNBEKANNT',
      accessibleStatus: 'unknown',
      neutralColor: 'bg-[#404040]',
    },
  ])(
    'renders the $status security state without implying cryptographic readiness',
    ({ status, visibleLabel, accessibleStatus, neutralColor }) => {
      act(() => {
        root.render(
          <HeaderBar
            backendStatusColor="bg-[#3a6b4a]"
            securityConfigurationStatus={status}
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
            detectionEnabled={false}
            highestThreat={null}
          />
        )
      })

      const securityStatus = container.querySelector(
        `[data-security-configuration-status="${status}"]`
      )
      const indicator = securityStatus?.querySelector('[data-security-status-indicator]')

      expect(securityStatus?.textContent).toContain(`KRYPTO${visibleLabel}`)
      expect(securityStatus?.getAttribute('aria-label')).toBe(
        `Cryptographic transport configuration: ${accessibleStatus}. TLS and access-control enforcement are not attested.`
      )
      expect(securityStatus?.getAttribute('title')).toContain(
        'does not attest TLS or access-control enforcement'
      )
      expect(indicator?.classList.contains(neutralColor)).toBe(true)
      expect(indicator?.classList.contains('bg-[#a08040]')).toBe(false)
      expect(indicator?.classList.contains('bg-[#3a6b4a]')).toBe(false)
      expect(
        Array.from(securityStatus?.querySelectorAll('span') ?? []).every((element) =>
          element.classList.contains('text-[#8a8a8a]')
        )
      ).toBe(true)
    }
  )
})

describe('ViewerOverlayRail accessibility', () => {
  it('is a keyboard scroll region only when the docked layout owns its geometry', () => {
    act(() => {
      root.render(
        <ViewerOverlayRail isDocked={false}>
          <div data-viewer-overlay="test">content</div>
        </ViewerOverlayRail>
      )
    })
    const rail = container.querySelector('[data-viewer-overlay-rail]') as HTMLElement
    expect(rail.getAttribute('role')).toBeNull()
    expect(rail.hasAttribute('tabindex')).toBe(false)

    act(() => {
      root.render(
        <ViewerOverlayRail isDocked>
          <div data-viewer-overlay="test">content</div>
        </ViewerOverlayRail>
      )
    })
    expect(rail.getAttribute('role')).toBe('region')
    expect(rail.getAttribute('aria-label')).toBe('Viewer information overlays')
    expect(rail.tabIndex).toBe(0)
    Object.defineProperties(rail, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
    })
    rail.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }))
    expect(rail.scrollTop).toBe(600)
  })
})

describe('ViewerFooter accessibility', () => {
  it('exposes the persistent feed-toggle state', () => {
    const renderFooter = (feedsVisible: boolean) => (
      <ViewerFooter
        readOnly={false}
        paused
        feedsVisible={feedsVisible}
        onTogglePause={() => {}}
        onResetSimulation={() => {}}
        onToggleFeeds={() => {}}
        onResetCamera={() => {}}
        onFocusContent={() => {}}
      />
    )

    act(() => root.render(renderFooter(false)))
    expect(container.querySelector('button[aria-pressed="false"]')?.textContent).toBe('FEEDS')

    act(() => root.render(renderFooter(true)))
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe('FEEDS')
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
