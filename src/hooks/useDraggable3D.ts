/**
 * CREBAIN 3D Object Dragging Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Provides 3D object dragging with plane-based movement, floor snapping,
 * and smooth interaction. Adapted from Dreamweave's positioning system.
 *
 * Features:
 * - Plane-based dragging parallel to camera view
 * - Floor plane snapping with configurable threshold
 * - Offset calculation to prevent "jumping" on grab
 * - Automatic OrbitControls disabling during drag
 * - Support for any THREE.Object3D
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { objectId } from '../lib/three/sceneObjects'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface Draggable3DConfig {
  /** Reference to the container element for pointer events */
  containerRef: React.RefObject<HTMLElement | null>
  /** Reference to the camera */
  cameraRef: React.RefObject<THREE.PerspectiveCamera | null>
  /** Reference to the scene */
  sceneRef: React.RefObject<THREE.Scene | null>
  /** Reference to orbit controls (will be disabled during drag) */
  controlsRef?: React.RefObject<OrbitControls | null>
  /** Objects that can be dragged */
  draggableObjects: THREE.Object3D[]
  /** Floor Y level for snapping (default: 0) */
  floorY?: number
  /** Snap distance threshold (default: 0.5) */
  snapThreshold?: number
  /** Enable floor snapping (default: true) */
  enableFloorSnap?: boolean
  /** Callback when drag starts */
  onDragStart?: (object: THREE.Object3D) => void
  /** Callback during drag; position is in world coordinates */
  onDrag?: (object: THREE.Object3D, position: THREE.Vector3) => void
  /** Callback when drag ends; position is in world coordinates */
  onDragEnd?: (object: THREE.Object3D, position: THREE.Vector3) => void
  /** Whether dragging is enabled (default: true) */
  enabled?: boolean
}

export interface Draggable3DState {
  isDragging: boolean
  draggedObjectId: string | null
  plane: THREE.Plane
  offset: THREE.Vector3
  /** Original object-local position, used to cancel the drag exactly. */
  startPosition: THREE.Vector3
}

export interface Draggable3DReturn {
  /** Whether currently dragging */
  isDragging: boolean
  /** ID of the currently dragged object (from userData.id or uuid) */
  draggedObjectId: string | null
  /** Start drag programmatically */
  startDrag: (object: THREE.Object3D, event: PointerEvent | MouseEvent) => void
  /** Cancel current drag */
  cancelDrag: () => void
  /** Get the raycaster for external use */
  raycaster: THREE.Raycaster
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

function getObjectWorldPosition(object: THREE.Object3D, target: THREE.Vector3): THREE.Vector3 {
  object.updateWorldMatrix(true, false)
  return object.getWorldPosition(target)
}

function setObjectWorldPosition(object: THREE.Object3D, worldPosition: THREE.Vector3): void {
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false)
    object.position.copy(object.parent.worldToLocal(worldPosition.clone()))
  } else {
    object.position.copy(worldPosition)
  }
  object.updateWorldMatrix(false, true)
}

export function useDraggable3D(config: Draggable3DConfig): Draggable3DReturn {
  const {
    containerRef,
    cameraRef,
    sceneRef: _sceneRef,
    controlsRef,
    draggableObjects,
    floorY = 0,
    snapThreshold = 0.5,
    enableFloorSnap = true,
    onDragStart,
    onDrag,
    onDragEnd,
    enabled = true,
  } = config

  const [isDragging, setIsDragging] = useState(false)
  const [draggedObjectId, setDraggedObjectId] = useState<string | null>(null)

  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster())
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2())

  const dragState = useRef<Draggable3DState>({
    isDragging: false,
    draggedObjectId: null,
    plane: new THREE.Plane(),
    offset: new THREE.Vector3(),
    startPosition: new THREE.Vector3(),
  })

  const draggedObjectRef = useRef<THREE.Object3D | null>(null)
  const capturedPointerRef = useRef<{ container: HTMLElement; pointerId: number } | null>(null)
  const activeControlsRef = useRef<{ controls: OrbitControls; wasEnabled: boolean } | null>(null)

  // Get object ID helper
  const getObjectId = useCallback((obj: THREE.Object3D): string => objectId(obj), [])

  // Convert pointer event to normalized device coordinates
  const getNDC = useCallback(
    (event: PointerEvent | MouseEvent): THREE.Vector2 => {
      const container = containerRef.current
      if (!container) return new THREE.Vector2()

      const rect = container.getBoundingClientRect()
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      )
    },
    [containerRef]
  )

  const releasePointerCapture = useCallback(() => {
    const capturedPointer = capturedPointerRef.current
    capturedPointerRef.current = null
    if (!capturedPointer) return

    try {
      capturedPointer.container.releasePointerCapture(capturedPointer.pointerId)
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }, [])

  const restoreOrbitControls = useCallback(() => {
    const activeControls = activeControlsRef.current
    activeControlsRef.current = null
    if (activeControls) activeControls.controls.enabled = activeControls.wasEnabled
  }, [])

  const resetDragState = useCallback(
    (updateReactState: boolean) => {
      releasePointerCapture()
      restoreOrbitControls()
      dragState.current.isDragging = false
      dragState.current.draggedObjectId = null
      draggedObjectRef.current = null

      if (updateReactState) {
        setIsDragging(false)
        setDraggedObjectId(null)
      }
    },
    [releasePointerCapture, restoreOrbitControls]
  )

  const cancelActiveDrag = useCallback(
    (updateReactState: boolean) => {
      const draggedObject = draggedObjectRef.current
      if (dragState.current.isDragging && draggedObject) {
        // startPosition is deliberately object-local, so cancellation remains
        // exact even when a transformed parent owns the dragged object.
        draggedObject.position.copy(dragState.current.startPosition)
        draggedObject.updateWorldMatrix(false, true)
      }
      resetDragState(updateReactState)
    },
    [resetDragState]
  )

  // Start drag
  const beginDrag = useCallback(
    (object: THREE.Object3D, event: PointerEvent | MouseEvent) => {
      const camera = cameraRef.current
      if (!camera || !enabled || dragState.current.isDragging) return false

      const ndc = getNDC(event)
      mouseRef.current.copy(ndc)
      raycasterRef.current.setFromCamera(mouseRef.current, camera)

      // Ray/plane intersections are world-space operations. Object.position is
      // parent-local, so use the object's actual world center for the plane and
      // offset and convert back to local coordinates only when applying motion.
      const objectWorldPosition = getObjectWorldPosition(object, new THREE.Vector3())
      const normal = new THREE.Vector3()
      camera.getWorldDirection(normal)
      dragState.current.plane.setFromNormalAndCoplanarPoint(normal, objectWorldPosition)

      // Calculate offset from intersection point to object center
      const intersectPoint = new THREE.Vector3()
      const intersected = raycasterRef.current.ray.intersectPlane(
        dragState.current.plane,
        intersectPoint
      )
      if (!intersected) {
        // Ray is parallel to plane, can't start drag
        return false
      }
      dragState.current.offset.subVectors(objectWorldPosition, intersectPoint)
      dragState.current.startPosition.copy(object.position)

      // Store references
      dragState.current.isDragging = true
      dragState.current.draggedObjectId = getObjectId(object)
      draggedObjectRef.current = object

      // Disable orbit controls during drag
      if (controlsRef?.current) {
        activeControlsRef.current = {
          controls: controlsRef.current,
          wasEnabled: controlsRef.current.enabled,
        }
        controlsRef.current.enabled = false
      }

      try {
        onDragStart?.(object)
      } catch (error) {
        cancelActiveDrag(false)
        throw error
      }

      setIsDragging(true)
      setDraggedObjectId(dragState.current.draggedObjectId)
      return true
    },
    [cameraRef, controlsRef, enabled, getNDC, getObjectId, onDragStart, cancelActiveDrag]
  )

  const startDrag = useCallback(
    (object: THREE.Object3D, event: PointerEvent | MouseEvent) => {
      beginDrag(object, event)
    },
    [beginDrag]
  )

  // Cancel drag
  const cancelDrag = useCallback(() => {
    if (!dragState.current.isDragging) return
    cancelActiveDrag(true)
  }, [cancelActiveDrag])

  // Pointer event handlers
  useEffect(() => {
    const container = containerRef.current
    const camera = cameraRef.current
    if (!container || !camera || !enabled) return

    const handlePointerDown = (event: PointerEvent) => {
      // Only handle left click
      if (event.button !== 0) return

      // Ignore UI elements
      const target = event.target as HTMLElement
      if (target.closest('button, input, [data-no-drag]')) return

      const ndc = getNDC(event)
      mouseRef.current.copy(ndc)
      raycasterRef.current.setFromCamera(mouseRef.current, camera)

      // Check intersection with draggable objects
      const intersects = raycasterRef.current.intersectObjects(draggableObjects, true)

      if (intersects.length > 0) {
        // Find the root draggable object
        let targetObject = intersects[0].object
        while (targetObject.parent && !draggableObjects.includes(targetObject)) {
          if (targetObject.parent.type === 'Scene') break
          targetObject = targetObject.parent
        }

        // If we found a draggable object, start drag
        const draggable = draggableObjects.find(
          (obj) => obj === targetObject || obj.children.some((child) => child === targetObject)
        )

        if (draggable) {
          const started = beginDrag(draggable, event)
          if (!started) return

          event.preventDefault()
          event.stopPropagation()
          try {
            container.setPointerCapture(event.pointerId)
            capturedPointerRef.current = { container, pointerId: event.pointerId }
          } catch {
            // A drag without capture can strand controls when the pointer leaves
            // the element, so fail closed and restore the pre-drag state.
            cancelActiveDrag(true)
          }
        }
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragState.current.isDragging || !draggedObjectRef.current) return

      const ndc = getNDC(event)
      mouseRef.current.copy(ndc)
      raycasterRef.current.setFromCamera(mouseRef.current, camera)

      // Intersect ray with drag plane
      const intersectPoint = new THREE.Vector3()
      if (raycasterRef.current.ray.intersectPlane(dragState.current.plane, intersectPoint)) {
        // Apply offset to get the new world position.
        const newWorldPosition = intersectPoint.add(dragState.current.offset)

        // Apply floor snapping if enabled
        if (enableFloorSnap) {
          const distanceToFloor = Math.abs(newWorldPosition.y - floorY)
          if (distanceToFloor < snapThreshold) {
            newWorldPosition.y = floorY
          }
        }

        // Convert the world-space drag result to the object's parent-local
        // coordinates before assigning Object3D.position.
        const draggedObject = draggedObjectRef.current
        setObjectWorldPosition(draggedObject, newWorldPosition)

        try {
          onDrag?.(draggedObject, newWorldPosition.clone())
        } catch (error) {
          cancelActiveDrag(true)
          throw error
        }
      }
    }

    const handlePointerUp = () => {
      if (!dragState.current.isDragging || !draggedObjectRef.current) return

      const draggedObject = draggedObjectRef.current
      const finalWorldPosition = getObjectWorldPosition(draggedObject, new THREE.Vector3())

      // Apply final floor snap if close enough
      if (enableFloorSnap) {
        const distanceToFloor = Math.abs(finalWorldPosition.y - floorY)
        if (distanceToFloor < snapThreshold) {
          finalWorldPosition.y = floorY
          setObjectWorldPosition(draggedObject, finalWorldPosition)
        }
      }

      try {
        onDragEnd?.(draggedObject, finalWorldPosition.clone())
      } finally {
        // Pointer capture and OrbitControls must be restored even if a consumer
        // callback fails.
        resetDragState(true)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragState.current.isDragging) {
        cancelDrag()
      }
    }

    // Handle pointer cancel (e.g., touch interrupted, pointer leaves window)
    const handlePointerCancel = () => {
      if (dragState.current.isDragging) cancelDrag()
    }

    // Touch support - save original value for cleanup
    const originalTouchAction = container.style.touchAction
    container.style.touchAction = 'none'

    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('pointermove', handlePointerMove)
    container.addEventListener('pointerup', handlePointerUp)
    container.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      container.style.touchAction = originalTouchAction
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('pointermove', handlePointerMove)
      container.removeEventListener('pointerup', handlePointerUp)
      container.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    containerRef,
    cameraRef,
    controlsRef,
    draggableObjects,
    enabled,
    enableFloorSnap,
    floorY,
    snapThreshold,
    getNDC,
    beginDrag,
    cancelDrag,
    cancelActiveDrag,
    resetDragState,
    onDrag,
    onDragEnd,
  ])

  useEffect(() => {
    if (!enabled && dragState.current.isDragging) cancelDrag()
  }, [enabled, cancelDrag])

  const cancelActiveDragRef = useRef(cancelActiveDrag)
  cancelActiveDragRef.current = cancelActiveDrag
  useEffect(
    () => () => {
      // No React updates during unmount, but always release pointer capture,
      // restore the original OrbitControls state, and roll back partial motion.
      cancelActiveDragRef.current(false)
    },
    []
  )

  return {
    isDragging,
    draggedObjectId,
    startDrag,
    cancelDrag,
    raycaster: raycasterRef.current,
  }
}

export default useDraggable3D
