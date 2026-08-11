import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerformancePanel, type PerformanceData } from '../PerformancePanel'

vi.mock('../../hooks/useDraggablePanel', () => ({
  useDraggablePanel: () => ({
    panelStyle: {},
    handleMouseDown: vi.fn(),
    handleHeaderClick: vi.fn(),
    elementRef: { current: null },
  }),
}))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

function sample(timestamp: number): PerformanceData {
  return {
    inferenceTimeMs: 10,
    detectionCount: 1,
    timestamp,
  }
}

describe('PerformancePanel', () => {
  it('calculates FPS from completed intervals rather than sample count', () => {
    act(() => {
      root.render(
        <PerformancePanel
          data={sample(2_000)}
          history={[sample(1_000), sample(2_000)]}
          status="ready"
          error={null}
        />
      )
    })

    const fpsLabel = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'FPS'
    )
    expect(fpsLabel?.parentElement?.textContent).toBe('FPS1.0')
  })

  it('reports zero FPS for unordered timestamps', () => {
    act(() => {
      root.render(
        <PerformancePanel
          data={sample(1_000)}
          history={[sample(2_000), sample(1_000)]}
          status="ready"
          error={null}
        />
      )
    })

    const fpsLabel = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'FPS'
    )
    expect(fpsLabel?.parentElement?.textContent).toBe('FPS0.0')
  })

  it('starts collapsed for a restricted host and exposes keyboard disclosure semantics', () => {
    act(() => {
      root.render(
        <PerformancePanel
          data={null}
          history={[]}
          status="ready"
          error={null}
          initiallyExpanded={false}
        />
      )
    })

    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand performance panel"]'
    )
    expect(disclosure).not.toBeNull()
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('#performance-panel-content')).toBeNull()
    const dragSurface = container.querySelector<HTMLElement>('[data-drag-handle]')
    expect(dragSurface?.tagName).toBe('DIV')
    expect(disclosure?.hasAttribute('data-drag-handle')).toBe(false)
    expect(dragSurface?.contains(disclosure ?? null)).toBe(true)
  })

  it.each([
    ['loading', 'Loading'],
    ['unavailable', 'Unavailable'],
    ['initializing', 'Initializing'],
    ['busy', 'Busy'],
    ['unknown', 'Unknown'],
    ['error', 'Error'],
  ] as const)('renders the %s backend state truthfully', (status, label) => {
    act(() => {
      root.render(<PerformancePanel data={null} history={[]} status={status} error={null} />)
    })

    expect(container.querySelector('[role="status"]')?.textContent).toBe(label)
  })
})
