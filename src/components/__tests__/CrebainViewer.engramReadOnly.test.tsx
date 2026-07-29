import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as Three from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CrebainViewer from '../CrebainViewer'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  embedded: false,
  animationLoop: vi.fn(),
  controllerOptions: vi.fn(),
  detectionOptions: vi.fn(),
  selectionOptions: vi.fn(),
  dragOptions: vi.fn(),
  togglePause: vi.fn(),
  resetSimulation: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
  isTauri: vi.fn(() => false),
}))

vi.mock('@sparkjsdev/spark', () => ({
  SplatMesh: class {},
}))

vi.mock('../../integrations/engramHost', () => ({
  isEngramEmbeddedMode: () => mocks.embedded,
  isNativeBackendAvailable: () => false,
}))

vi.mock('../../hooks/useDetectionLoop', () => ({
  useDetectionLoop: (options: unknown) => {
    mocks.detectionOptions(options)
  },
}))

vi.mock('../../hooks/useDroneController', () => ({
  useDroneController: (options: unknown) => {
    mocks.controllerOptions(options)
    return {
      drones: [],
      physicsReady: true,
      selectedDroneId: null,
      spawnDrone: vi.fn(async () => null),
      removeDrone: vi.fn(),
      selectDrone: vi.fn(),
      setRoute: vi.fn(() => true),
      clearRoute: vi.fn(),
      toggleRoute: vi.fn(),
      renameDrone: vi.fn(),
      physicsWorld: null,
      isPaused: true,
      togglePause: mocks.togglePause,
      setSimulationPaused: vi.fn(),
      resetSimulation: mocks.resetSimulation,
    }
  },
}))

vi.mock('../../hooks/useSceneState', () => ({
  useSceneState: () => ({
    saveCurrentState: vi.fn(),
  }),
}))

vi.mock('../../hooks/useDraggable', () => ({
  useDraggable: () => ({
    position: { x: 12, y: 80 },
    isDragging: false,
    wasDragged: false,
    handleMouseDown: vi.fn(),
    elementRef: { current: null },
    isSnapped: { left: true, right: false, top: false, bottom: false },
  }),
}))

vi.mock('../../hooks/useObjectSelection', () => ({
  useObjectSelection: (options: unknown) => {
    mocks.selectionOptions(options)
    return {
      selectedObjects: [],
      primarySelection: null,
      select: vi.fn(),
      deselect: vi.fn(),
      clearSelection: vi.fn(),
      isSelected: vi.fn(() => false),
      deleteSelected: vi.fn(),
    }
  },
}))

vi.mock('../../hooks/useDraggable3D', () => ({
  useDraggable3D: (options: unknown) => {
    mocks.dragOptions(options)
    return {
      isDragging: false,
      draggedObjectId: null,
      startDrag: vi.fn(),
      cancelDrag: vi.fn(),
      raycaster: null,
    }
  },
}))

vi.mock('../../context/useUIScale', () => ({
  useUIScale: () => ({
    increaseScale: vi.fn(),
    decreaseScale: vi.fn(),
    scalePercent: 100,
    isAtMin: false,
    isAtMax: false,
    cssVar: { '--ui-scale': 1 },
  }),
}))

vi.mock('../DroneSpawnPanel', () => ({
  default: () => <div data-testid="drone-spawn-panel">DRONE SPAWN PANEL</div>,
}))

vi.mock('../SaveLoadPanel', () => ({
  default: () => <div data-testid="save-load-panel">SAVE LOAD PANEL</div>,
}))

vi.mock('../ObjectTransformControls', () => ({
  default: () => <div data-testid="object-transform-controls">OBJECT TRANSFORM</div>,
}))

vi.mock('../viewer/TacticalGrid', async () => {
  const THREE = await import('three')
  return {
    createTacticalGrid: (scene: InstanceType<typeof THREE.Scene>) => {
      const mesh = new THREE.Mesh()
      scene.add(mesh)
      return mesh
    },
    createGridLabels: (scene: InstanceType<typeof THREE.Scene>) => {
      const group = new THREE.Group()
      scene.add(group)
      return group
    },
  }
})

vi.mock('three/addons/controls/OrbitControls.js', () => {
  class OrbitControls {
    target = {
      add: vi.fn().mockReturnThis(),
      applyAxisAngle: vi.fn().mockReturnThis(),
      copy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      sub: vi.fn().mockReturnThis(),
    }
    enableDamping = false
    dampingFactor = 0
    rotateSpeed = 0
    panSpeed = 0
    zoomSpeed = 0
    minDistance = 0
    maxDistance = 0
    enablePan = false
    screenSpacePanning = false
    maxPolarAngle = 0
    update = vi.fn()
    dispose = vi.fn()
  }

  return { OrbitControls }
})

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {},
}))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>()

  class WebGLRenderer {
    domElement = document.createElement('canvas')
    outputColorSpace = actual.SRGBColorSpace
    toneMapping = actual.NoToneMapping
    toneMappingExposure = 1
    shadowMap = { enabled: false, type: actual.BasicShadowMap }
    setSize = vi.fn()
    setPixelRatio = vi.fn()
    render = vi.fn()
    readRenderTargetPixels = vi.fn()
    setRenderTarget = vi.fn()
    getRenderTarget = vi.fn(() => null)
    dispose = vi.fn()
    forceContextLoss = vi.fn()

    setAnimationLoop(callback: unknown) {
      mocks.animationLoop(callback)
    }
  }

  return { ...actual, WebGLRenderer }
})

let root: Root
let container: HTMLDivElement
const detectionWindow = window as Window & {
  crebainDetectionHandler?: (cameraId: string, detections: unknown[]) => void
}

async function renderViewer(embedded: boolean) {
  mocks.embedded = embedded
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<CrebainViewer />))
}

function dispatchKey(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...init }))
}

describe('CrebainViewer Engram read-only composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.embedded = false
    delete detectionWindow.crebainDetectionHandler
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
    document.body.replaceChildren()
  })

  it('preserves standalone simulation, deployment, editing, and controller paths', async () => {
    await renderViewer(false)

    expect(mocks.controllerOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true })
    )
    expect(mocks.detectionOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
    expect(mocks.selectionOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true })
    )
    expect(container.querySelector('[data-testid="drone-spawn-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="save-load-panel"]')).not.toBeNull()
    expect(detectionWindow.crebainDetectionHandler).toBeTypeOf('function')
    expect(container.textContent).toContain('START SIM')
    expect(container.textContent).toContain('SIM-RESET')
    expect(container.textContent).toContain('BEREITSTELLUNG')

    const objectsTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'OBJEKTE'
    )
    await act(async () => objectsTab?.click())
    expect(container.textContent).toContain('BODEN')

    const startSimulation = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('START SIM')
    )
    await act(async () => startSimulation?.click())
    expect(mocks.togglePause).toHaveBeenCalledTimes(1)

    await act(async () => dispatchKey('1'))
    expect(container.textContent).toContain('SK-PLATZIERUNG AKTIV')
  })

  it('removes hosted mutation controls and keeps only presentation shortcuts active', async () => {
    await renderViewer(true)

    expect(mocks.controllerOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
    expect(mocks.detectionOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
    expect(mocks.selectionOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
    expect(mocks.dragOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    expect(container.querySelector('[data-testid="engram-hosted-read-only-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="drone-spawn-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="save-load-panel"]')).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(detectionWindow.crebainDetectionHandler).toBeUndefined()
    expect(container.textContent).not.toContain('START SIM')
    expect(container.textContent).not.toContain('SIM-RESET')
    expect(container.textContent).not.toContain('BEREITSTELLUNG')
    expect(container.textContent).not.toContain('BODEN')
    expect(container.textContent).not.toContain('NATIVE TESTEN')

    await act(async () => {
      dispatchKey('1')
      dispatchKey('2')
      dispatchKey('3')
      dispatchKey('y')
      dispatchKey('m')
      dispatchKey('o', { ctrlKey: true })
    })

    expect(container.textContent).not.toContain('PLATZIERUNG AKTIV')
    expect(container.textContent).not.toContain('LEISTUNGSMODUS')
    expect(mocks.togglePause).not.toHaveBeenCalled()
    expect(mocks.resetSimulation).not.toHaveBeenCalled()

    expect(container.textContent).toContain('RASTER: EIN')
    await act(async () => dispatchKey('g'))
    expect(container.textContent).toContain('RASTER: AUS')
    expect(container.textContent).toContain('CAM-RESET')
    expect(container.textContent).toContain('FOKUS')
  })
})
