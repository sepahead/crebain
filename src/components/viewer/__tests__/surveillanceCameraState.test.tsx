import { readFileSync } from 'node:fs'
import { StrictMode, useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import {
  disposeAllSurveillanceCamerasOnce,
  removeSurveillanceCameraOnce,
  type SurveillanceCameraStore,
  updateSurveillanceCameraPtz,
} from '../surveillanceCameraState'
import type { SurveillanceCamera } from '../types'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function makeCamera(id = 'camera-1'): {
  camera: SurveillanceCamera
  geometry: THREE.BufferGeometry
  material: THREE.Material
} {
  const feedCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
  const helper = new THREE.CameraHelper(feedCamera)
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Group()
  mesh.add(new THREE.Mesh(geometry, material))

  return {
    camera: {
      id,
      name: 'PTZ-1',
      type: 'ptz',
      camera: feedCamera,
      helper,
      mesh,
      renderTarget: new THREE.WebGLRenderTarget(16, 16),
      pan: 0,
      tilt: 0,
      zoom: 60,
      isActive: true,
      isRecording: false,
    },
    geometry,
    material,
  }
}

function CameraMutationHarness({
  scene,
  store,
  onCommit,
  onRemoved,
}: {
  scene: THREE.Scene
  store: SurveillanceCameraStore
  onCommit: (next: SurveillanceCamera[]) => void
  onRemoved: (camera: SurveillanceCamera) => void
}) {
  const [cameras, setCameras] = useState(store.current)
  const commit = (next: SurveillanceCamera[]): void => {
    onCommit(next)
    setCameras(next)
  }

  return (
    <div>
      <output data-testid="camera-state">
        {cameras.length === 0
          ? 'removed'
          : `${cameras[0].pan}/${cameras[0].tilt}/${cameras[0].zoom}`}
      </output>
      <button
        type="button"
        data-testid="ptz"
        onClick={() => updateSurveillanceCameraPtz(store, commit, 'camera-1', 45, -100, 140)}
      >
        PTZ
      </button>
      <button
        type="button"
        data-testid="remove"
        onClick={() => removeSurveillanceCameraOnce(scene, store, commit, 'camera-1', onRemoved)}
      >
        Remove
      </button>
    </div>
  )
}

describe('surveillance camera state transactions', () => {
  it('keeps resource-backed camera commits out of replayable functional updaters', () => {
    const path = `${process.cwd()}/src/components/CrebainViewer.tsx`
    const sourceText = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const replayableCommits: string[] = []

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['setCameras', 'setCameraDetections'].includes(node.expression.text)
      ) {
        const firstArgument = node.arguments[0]
        if (
          firstArgument &&
          (ts.isArrowFunction(firstArgument) || ts.isFunctionExpression(firstArgument))
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          replayableCommits.push(`${node.expression.text}:${line + 1}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    expect(replayableCommits).toEqual([])
    expect(sourceText).toContain(
      'updateSurveillanceCameraPtz(camerasRef, setCameras, cameraId, pan, tilt, zoom)'
    )
    expect(sourceText).toContain('removeSurveillanceCameraOnce(')
  })

  it('commits PTZ and one-shot removal outside replayable state updaters under StrictMode', async () => {
    const { camera, geometry, material } = makeCamera()
    const scene = new THREE.Scene()
    scene.add(camera.helper, camera.mesh)
    const store: SurveillanceCameraStore = { current: [camera] }
    const onCommit = vi.fn<(next: SurveillanceCamera[]) => void>()
    const onRemoved = vi.fn<(removed: SurveillanceCamera) => void>()
    const projectionSpy = vi.spyOn(camera.camera, 'updateProjectionMatrix')
    const helperDisposeSpy = vi.spyOn(camera.helper, 'dispose')
    const targetDisposeSpy = vi.spyOn(camera.renderTarget, 'dispose')
    const geometryDisposeSpy = vi.spyOn(geometry, 'dispose')
    const materialDisposeSpy = vi.spyOn(material, 'dispose')
    const removeFromScene = scene.remove.bind(scene)
    let reentrantRemovalAttempted = false
    const sceneRemoveSpy = vi.spyOn(scene, 'remove').mockImplementation((...objects) => {
      const result = removeFromScene(...objects)
      if (!reentrantRemovalAttempted) {
        reentrantRemovalAttempted = true
        removeSurveillanceCameraOnce(scene, store, onCommit, 'camera-1', onRemoved)
      }
      return result
    })
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <StrictMode>
          <CameraMutationHarness
            scene={scene}
            store={store}
            onCommit={onCommit}
            onRemoved={onRemoved}
          />
        </StrictMode>
      )
    })

    const ptz = container.querySelector<HTMLButtonElement>('[data-testid="ptz"]')
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="remove"]')
    const state = container.querySelector<HTMLOutputElement>('[data-testid="camera-state"]')
    expect(ptz).not.toBeNull()
    expect(remove).not.toBeNull()
    expect(state).not.toBeNull()

    await act(async () => ptz?.click())

    expect(projectionSpy).toHaveBeenCalledOnce()
    expect(store.current[0]).toMatchObject({ pan: 45, tilt: -85, zoom: 120 })
    const updatedCamera = store.current[0]
    expect(state?.textContent).toBe('45/-85/120')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(Array.isArray(onCommit.mock.calls[0]?.[0])).toBe(true)

    await act(async () => remove?.click())

    expect(store.current).toEqual([])
    expect(state?.textContent).toBe('removed')
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(Array.isArray(onCommit.mock.calls[1]?.[0])).toBe(true)
    expect(onRemoved).toHaveBeenCalledOnce()
    expect(onRemoved).toHaveBeenCalledWith(updatedCamera)
    expect(helperDisposeSpy).toHaveBeenCalledOnce()
    expect(targetDisposeSpy).toHaveBeenCalledOnce()
    expect(geometryDisposeSpy).toHaveBeenCalledOnce()
    expect(materialDisposeSpy).toHaveBeenCalledOnce()
    expect(sceneRemoveSpy).toHaveBeenCalledTimes(2)
    expect(sceneRemoveSpy).toHaveBeenCalledWith(camera.helper)
    expect(sceneRemoveSpy).toHaveBeenCalledWith(camera.mesh)
    expect(reentrantRemovalAttempted).toBe(true)

    await act(async () => remove?.click())
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onRemoved).toHaveBeenCalledOnce()
    expect(helperDisposeSpy).toHaveBeenCalledOnce()
    expect(targetDisposeSpy).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
  })

  it('tombstones a bulk camera snapshot before synchronous disposal hooks can reenter', () => {
    const first = makeCamera('camera-1')
    const second = makeCamera('camera-2')
    const scene = new THREE.Scene()
    scene.add(first.camera.helper, first.camera.mesh, second.camera.helper, second.camera.mesh)
    const store: SurveillanceCameraStore = { current: [first.camera, second.camera] }
    const commit = vi.fn<(next: SurveillanceCamera[]) => void>()
    const firstHelperDispose = vi.spyOn(first.camera.helper, 'dispose')
    const firstTargetDispose = vi.spyOn(first.camera.renderTarget, 'dispose')
    const secondHelperDispose = vi.spyOn(second.camera.helper, 'dispose')
    const secondTargetDispose = vi.spyOn(second.camera.renderTarget, 'dispose')
    const removeFromScene = scene.remove.bind(scene)
    const reentrantResults: Array<SurveillanceCamera | null> = []
    let reentered = false
    vi.spyOn(scene, 'remove').mockImplementation((...objects) => {
      const result = removeFromScene(...objects)
      if (!reentered) {
        reentered = true
        reentrantResults.push(
          removeSurveillanceCameraOnce(scene, store, commit, 'camera-1', vi.fn())
        )
        expect(disposeAllSurveillanceCamerasOnce(scene, store, commit)).toEqual([])
      }
      return result
    })

    const disposed = disposeAllSurveillanceCamerasOnce(scene, store, commit)

    expect(disposed).toEqual([first.camera, second.camera])
    expect(store.current).toEqual([])
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith([])
    expect(reentrantResults).toEqual([null])
    expect(firstHelperDispose).toHaveBeenCalledOnce()
    expect(firstTargetDispose).toHaveBeenCalledOnce()
    expect(secondHelperDispose).toHaveBeenCalledOnce()
    expect(secondTargetDispose).toHaveBeenCalledOnce()
  })
})
