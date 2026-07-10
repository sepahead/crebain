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
          isReady
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
          isReady
          error={null}
        />
      )
    })

    const fpsLabel = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'FPS'
    )
    expect(fpsLabel?.parentElement?.textContent).toBe('FPS0.0')
  })
})
