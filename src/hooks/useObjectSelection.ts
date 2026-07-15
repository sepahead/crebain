/**
 * CREBAIN 3D Object Selection Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Provides click-to-select functionality for 3D objects with visual
 * selection indicators (ring/glow) and keyboard shortcuts.
 * Adapted from Dreamweave's selection system.
 *
 * Features:
 * - Click-to-select with raycasting
 * - Visual selection ring indicator at floor level
 * - Delete key to remove selected object
 * - Escape to deselect
 * - Multi-select support (optional, with Shift key)
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import * as THREE from 'three'
import { objectId } from '../lib/three/sceneObjects'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectableObject extends THREE.Object3D {
  userData: {
    id?: string
    assetId?: string
    selectable?: boolean
    [key: string]: unknown
  }
}

export interface ObjectSelectionConfig {
  /** Reference to the container element for pointer events */
  containerRef: React.RefObject<HTMLElement | null>
  /** Reference to the camera */
  cameraRef: React.RefObject<THREE.PerspectiveCamera | null>
  /** Reference to the scene */
  sceneRef: React.RefObject<THREE.Scene | null>
  /** Objects that can be selected */
  selectableObjects: THREE.Object3D[]
  /** Enable multi-select with Shift key (default: false) */
  multiSelect?: boolean
  /** Show selection ring indicator (default: true) */
  showSelectionRing?: boolean
  /** Selection ring color (default: 0x4a8b5a - tactical green) */
  ringColor?: number
  /** Callback when selection changes */
  onSelectionChange?: (selected: THREE.Object3D[]) => void
  /** Callback when object is deleted */
  onDelete?: (object: THREE.Object3D) => void
  /** Whether selection is enabled (default: true) */
  enabled?: boolean
}

export interface ObjectSelectionReturn {
  /** Currently selected objects */
  selectedObjects: THREE.Object3D[]
  /** Primary selected object (first in selection) */
  primarySelection: THREE.Object3D | null
  /** Select an object programmatically */
  select: (object: THREE.Object3D, addToSelection?: boolean) => void
  /** Deselect an object */
  deselect: (object: THREE.Object3D) => void
  /** Clear all selections */
  clearSelection: () => void
  /** Check if an object is selected */
  isSelected: (object: THREE.Object3D) => boolean
  /** Delete the currently selected object(s) */
  deleteSelected: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTION INDICATOR CREATION
// ─────────────────────────────────────────────────────────────────────────────

function createSelectionRing(object: THREE.Object3D, color: number): THREE.Mesh {
  // Calculate bounding box to size the ring appropriately
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const maxSize = Math.max(size.x, size.z) * 0.6

  // Create ring geometry
  const innerRadius = maxSize
  const outerRadius = maxSize + 0.1
  const ringGeom = new THREE.RingGeometry(innerRadius, outerRadius, 32)

  // Create material with glow effect
  const ringMat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.8,
  })

  const ring = new THREE.Mesh(ringGeom, ringMat)

  // Position horizontally at floor level
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.01 // Slightly above ground to prevent z-fighting

  // Mark as selection indicator
  ring.userData.isSelectionIndicator = true
  ring.name = `selection-ring-${object.uuid}`

  return ring
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useObjectSelection(config: ObjectSelectionConfig): ObjectSelectionReturn {
  const {
    containerRef,
    cameraRef,
    sceneRef,
    selectableObjects,
    multiSelect = false,
    showSelectionRing = true,
    ringColor = 0x4a8b5a,
    onSelectionChange,
    onDelete,
    enabled = true,
  } = config

  const [selectedObjects, setSelectedObjects] = useState<THREE.Object3D[]>([])
  const selectedObjectsRef = useRef<THREE.Object3D[]>([])
  const selectionRingsRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster())
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2())

  // Get object ID helper
  const getObjectId = useCallback((obj: THREE.Object3D): string => objectId(obj), [])

  // Add selection ring to object
  const addSelectionRing = useCallback(
    (object: THREE.Object3D) => {
      if (!showSelectionRing || !sceneRef.current) return

      const id = getObjectId(object)

      // Remove existing ring if any
      const existingRing = selectionRingsRef.current.get(id)
      if (existingRing) {
        sceneRef.current.remove(existingRing)
        existingRing.geometry.dispose()
        if (existingRing.material instanceof THREE.Material) {
          existingRing.material.dispose()
        }
      }

      // Create and add new ring
      const ring = createSelectionRing(object, ringColor)
      object.updateWorldMatrix(true, false)
      const worldPosition = object.getWorldPosition(new THREE.Vector3())
      ring.position.x = worldPosition.x
      ring.position.z = worldPosition.z
      sceneRef.current.add(ring)
      selectionRingsRef.current.set(id, ring)
    },
    [showSelectionRing, sceneRef, ringColor, getObjectId]
  )

  // Remove selection ring from object
  const removeSelectionRing = useCallback(
    (object: THREE.Object3D) => {
      if (!sceneRef.current) return

      const id = getObjectId(object)
      const ring = selectionRingsRef.current.get(id)
      if (ring) {
        sceneRef.current.remove(ring)
        ring.geometry.dispose()
        if (ring.material instanceof THREE.Material) {
          ring.material.dispose()
        }
        selectionRingsRef.current.delete(id)
      }
    },
    [sceneRef, getObjectId]
  )

  // Update ring positions when objects move
  // Uses RAF but only updates if positions have actually changed
  useEffect(() => {
    if (selectedObjects.length === 0) return

    // Track last known positions to avoid unnecessary updates
    const lastPositions = new Map<string, { x: number; z: number }>()
    const worldPosition = new THREE.Vector3()

    const updateRings = () => {
      selectedObjects.forEach((obj) => {
        const id = getObjectId(obj)
        const ring = selectionRingsRef.current.get(id)
        if (ring) {
          obj.updateWorldMatrix(true, false)
          obj.getWorldPosition(worldPosition)
          const last = lastPositions.get(id)
          // Only update if position changed
          if (!last || last.x !== worldPosition.x || last.z !== worldPosition.z) {
            ring.position.x = worldPosition.x
            ring.position.z = worldPosition.z
            lastPositions.set(id, { x: worldPosition.x, z: worldPosition.z })
          }
        }
      })
    }

    let frameId: number
    const animate = () => {
      updateRings()
      frameId = requestAnimationFrame(animate)
    }

    frameId = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [selectedObjects, getObjectId])

  const commitSelection = useCallback(
    (newSelection: THREE.Object3D[]) => {
      selectedObjectsRef.current = newSelection
      setSelectedObjects(newSelection)
      onSelectionChange?.(newSelection)
    },
    [onSelectionChange]
  )

  // Select an object
  const select = useCallback(
    (object: THREE.Object3D, addToSelection = false) => {
      if (!enabled) return

      const previousSelection = selectedObjectsRef.current
      let newSelection: THREE.Object3D[]

      if (addToSelection && multiSelect) {
        // Add to existing selection if not already selected
        if (previousSelection.some((obj) => getObjectId(obj) === getObjectId(object))) {
          return
        }
        newSelection = [...previousSelection, object]
      } else {
        // Clear previous selection rings
        previousSelection.forEach((obj) => removeSelectionRing(obj))
        newSelection = [object]
      }

      // Scene mutations and callbacks must not run inside React state updaters:
      // development Strict Mode may invoke updater functions more than once.
      addSelectionRing(object)
      commitSelection(newSelection)
    },
    [enabled, multiSelect, getObjectId, addSelectionRing, removeSelectionRing, commitSelection]
  )

  // Deselect an object
  const deselect = useCallback(
    (object: THREE.Object3D) => {
      const objectIdentifier = getObjectId(object)
      const previousSelection = selectedObjectsRef.current
      const selectedObject = previousSelection.find(
        (candidate) => getObjectId(candidate) === objectIdentifier
      )
      if (!selectedObject) return

      const newSelection = previousSelection.filter(
        (candidate) => getObjectId(candidate) !== objectIdentifier
      )
      removeSelectionRing(selectedObject)
      commitSelection(newSelection)
    },
    [getObjectId, removeSelectionRing, commitSelection]
  )

  // Clear all selections
  const clearSelection = useCallback(() => {
    selectedObjectsRef.current.forEach((obj) => removeSelectionRing(obj))
    commitSelection([])
  }, [removeSelectionRing, commitSelection])

  // Check if an object is selected
  const isSelected = useCallback(
    (object: THREE.Object3D): boolean => {
      return selectedObjects.some((obj) => getObjectId(obj) === getObjectId(object))
    },
    [selectedObjects, getObjectId]
  )

  // Delete selected objects
  const deleteSelected = useCallback(() => {
    if (!sceneRef.current) return

    const selection = [...selectedObjectsRef.current]
    selection.forEach((obj) => {
      removeSelectionRing(obj)
      onDelete?.(obj)
    })

    commitSelection([])
  }, [sceneRef, removeSelectionRing, onDelete, commitSelection])

  // Click handler for selection
  useEffect(() => {
    const container = containerRef.current
    const camera = cameraRef.current
    if (!container || !camera || !enabled) return

    const handleClick = (event: MouseEvent) => {
      // Only handle left click
      if (event.button !== 0) return

      // Ignore UI elements
      const target = event.target as HTMLElement
      if (target.closest('button, input, [data-no-select]')) return

      // Convert to NDC
      const rect = container.getBoundingClientRect()
      mouseRef.current.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      )

      // Raycast
      raycasterRef.current.setFromCamera(mouseRef.current, camera)
      const intersects = raycasterRef.current.intersectObjects(selectableObjects, true)

      if (intersects.length > 0) {
        // Find the root selectable object
        let targetObject = intersects[0].object
        while (targetObject.parent && !selectableObjects.includes(targetObject)) {
          if (targetObject.parent.type === 'Scene') break
          targetObject = targetObject.parent
        }

        // Find the actual selectable object
        const selectable = selectableObjects.find(
          (obj) => obj === targetObject || obj.children.some((child) => child === targetObject)
        )

        if (selectable) {
          // Toggle selection if clicking on already selected object
          if (isSelected(selectable) && !event.shiftKey) {
            deselect(selectable)
          } else {
            select(selectable, event.shiftKey)
          }
          return
        }
      }

      // Clicked on nothing - clear selection (unless shift is held)
      if (!event.shiftKey) {
        clearSelection()
      }
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [
    containerRef,
    cameraRef,
    selectableObjects,
    enabled,
    select,
    deselect,
    clearSelection,
    isSelected,
  ])

  // Keyboard handlers
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }

      switch (event.key) {
        case 'Escape':
          clearSelection()
          break
        case 'Delete':
        case 'Backspace':
          if (selectedObjects.length > 0) {
            event.preventDefault()
            deleteSelected()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, selectedObjects.length, clearSelection, deleteSelected])

  // Cleanup on unmount
  useEffect(() => {
    // Capture current scene ref for cleanup
    const scene = sceneRef.current
    const rings = selectionRingsRef.current

    return () => {
      // Remove all selection rings
      rings.forEach((ring) => {
        if (scene) {
          scene.remove(ring)
        }
        ring.geometry.dispose()
        if (Array.isArray(ring.material)) {
          ring.material.forEach((m) => m.dispose())
        } else if (ring.material instanceof THREE.Material) {
          ring.material.dispose()
        }
      })
      rings.clear()
      selectedObjectsRef.current = []
    }
    // sceneRef is a stable ref; listed to satisfy the deps linter without re-running.
  }, [sceneRef])

  return {
    selectedObjects,
    primarySelection: selectedObjects[0] || null,
    select,
    deselect,
    clearSelection,
    isSelected,
    deleteSelected,
  }
}

export default useObjectSelection
