/**
 * CREBAIN Object Transform Controls
 * Adaptive Response & Awareness System (ARAS)
 *
 * UI panel for manipulating selected 3D objects:
 * - Rotation (step-based, 22.5° increments)
 * - Scale (+/- controls)
 * - Position nudge buttons
 * - Delete button
 *
 * Adapted from Dreamweave's transform controls (lines 3337-3546)
 */

import { useCallback, useEffect, useState } from 'react'
import * as THREE from 'three'
import { useDraggable } from '../hooks/useDraggable'

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const ROTATION_STEP = Math.PI / 8 // 22.5 degrees
const SCALE_STEP = 0.05
const POSITION_NUDGE_BASE = 0.05

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface ObjectTransformControlsProps {
  /** The selected object to transform */
  object: THREE.Object3D | null
  /** Callback when object is deleted */
  onDelete?: (object: THREE.Object3D) => void
  /** Callback when transform changes */
  onTransform?: (object: THREE.Object3D) => void
  /** Initial position of the panel */
  initialPosition?: { x: number; y: number }
  /** Whether the panel is visible */
  visible?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export function ObjectTransformControls({
  object,
  onDelete,
  onTransform,
  initialPosition = { x: 12, y: 400 },
  visible = true,
}: ObjectTransformControlsProps) {
  const [isExpanded, setIsExpanded] = useState(true)

  // Draggable panel
  const panelDrag = useDraggable({
    initialPosition,
    snapDistance: 20,
    edgePadding: 12,
    side: 'left',
  })

  // Track if header click was a drag vs actual click
  const handleHeaderClick = useCallback(() => {
    // Only toggle if it wasn't a drag
    if (!panelDrag.wasDragged) {
      setIsExpanded((prev) => !prev)
    }
  }, [panelDrag.wasDragged])

  // Rotation controls
  const rotateX = useCallback(
    (direction: 1 | -1) => {
      if (!object) return
      object.rotation.x += ROTATION_STEP * direction
      onTransform?.(object)
    },
    [object, onTransform]
  )

  const rotateY = useCallback(
    (direction: 1 | -1) => {
      if (!object) return
      object.rotation.y += ROTATION_STEP * direction
      onTransform?.(object)
    },
    [object, onTransform]
  )

  const rotateZ = useCallback(
    (direction: 1 | -1) => {
      if (!object) return
      object.rotation.z += ROTATION_STEP * direction
      onTransform?.(object)
    },
    [object, onTransform]
  )

  // Scale controls
  const scaleUniform = useCallback(
    (direction: 1 | -1) => {
      if (!object) return
      const delta = SCALE_STEP * direction
      const newScale = Math.max(0.01, object.scale.x + delta)
      object.scale.set(newScale, newScale, newScale)
      onTransform?.(object)
    },
    [object, onTransform]
  )

  // Position nudge controls
  const nudgePosition = useCallback(
    (axis: 'x' | 'y' | 'z', direction: 1 | -1) => {
      if (!object) return
      const nudgeAmount = POSITION_NUDGE_BASE * object.scale.x * direction
      object.position[axis] += nudgeAmount
      onTransform?.(object)
    },
    [object, onTransform]
  )

  // Reset rotation
  const resetRotation = useCallback(() => {
    if (!object) return
    object.rotation.set(0, 0, 0)
    onTransform?.(object)
  }, [object, onTransform])

  // Reset scale
  const resetScale = useCallback(() => {
    if (!object) return
    object.scale.set(1, 1, 1)
    onTransform?.(object)
  }, [object, onTransform])

  // Delete object
  const handleDelete = useCallback(() => {
    if (!object) return
    onDelete?.(object)
  }, [object, onDelete])

  // Keyboard shortcuts when object is selected
  useEffect(() => {
    if (!object) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }

      // Only process if no modifier keys (except shift for direction)
      if (event.ctrlKey || event.metaKey || event.altKey) return

      switch (event.key.toLowerCase()) {
        // Rotation shortcuts
        case 'i':
          rotateX(-1)
          break // Rotate X negative (tilt forward)
        case 'k':
          rotateX(1)
          break // Rotate X positive (tilt back)
        case 'j':
          rotateY(-1)
          break // Rotate Y negative (turn left)
        case 'l':
          rotateY(1)
          break // Rotate Y positive (turn right)
        // ',' / '.' rather than 'u' / 'o': 'u' toggles the sensor-fusion panel
        // (APP_SHORTCUTS) and plain 'o' sits next to the Ctrl/Cmd+O file-open
        // binding — both fired here too when an object was selected.
        case ',':
          rotateZ(-1)
          break // Rotate Z negative
        case '.':
          rotateZ(1)
          break // Rotate Z positive

        // Scale shortcuts
        case '+':
        case '=':
          scaleUniform(1)
          break
        case '-':
        case '_':
          scaleUniform(-1)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [object, rotateX, rotateY, rotateZ, scaleUniform])

  if (!visible || !object) return null

  const userDataId: unknown = object.userData.id
  const objectName = object.name || (typeof userDataId === 'string' ? userDataId : '') || 'OBJEKT'
  const pos = object.position
  const rot = object.rotation
  const scl = object.scale

  return (
    <div
      ref={panelDrag.elementRef}
      className="fixed z-40 w-52"
      style={{
        left: `${panelDrag.position.x}px`,
        top: `${panelDrag.position.y}px`,
        cursor: panelDrag.isDragging ? 'grabbing' : undefined,
        fontSize: 'calc(8px * var(--ui-scale, 1))',
      }}
      onMouseDown={panelDrag.handleMouseDown}
    >
      <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
        {/* Header */}
        <div
          data-drag-handle
          className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010] cursor-grab select-none"
          onClick={handleHeaderClick}
        >
          <span
            className="text-[0.875em] text-[#909090] tracking-[0.2em] truncate"
            title={objectName}
          >
            {objectName.toUpperCase().slice(0, 12)}
          </span>
          <button className="text-[#505050] hover:text-[#707070]">{isExpanded ? '▼' : '▶'}</button>
        </div>

        {isExpanded && (
          <div className="p-3 space-y-3">
            {/* Position Display */}
            <div className="p-2 bg-[#0a0a0a] border border-[#1a1a1a]">
              <div className="text-[0.75em] text-[#606060] tracking-wider mb-1">POSITION</div>
              <div className="grid grid-cols-3 gap-2 text-[0.875em]">
                <div>
                  <span className="text-[#505050]">X:</span>
                  <span className="text-[#a0a0a0] ml-1">{pos.x.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-[#505050]">Y:</span>
                  <span className="text-[#a0a0a0] ml-1">{pos.y.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-[#505050]">Z:</span>
                  <span className="text-[#a0a0a0] ml-1">{pos.z.toFixed(2)}</span>
                </div>
              </div>
              {/* Nudge buttons */}
              <div className="grid grid-cols-3 gap-1 mt-2">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis} className="flex gap-0.5">
                    <button
                      onClick={() => nudgePosition(axis, -1)}
                      className="flex-1 py-1 bg-[#0e0e0e] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                    >
                      -{axis.toUpperCase()}
                    </button>
                    <button
                      onClick={() => nudgePosition(axis, 1)}
                      className="flex-1 py-1 bg-[#0e0e0e] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                    >
                      +{axis.toUpperCase()}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Rotation Controls */}
            <div className="p-2 bg-[#0a0a0a] border border-[#1a1a1a]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[0.75em] text-[#606060] tracking-wider">ROTATION</span>
                <button
                  onClick={resetRotation}
                  className="text-[0.625em] text-[#505050] hover:text-[#808080] px-1"
                >
                  RESET
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[0.875em] mb-2">
                <div>
                  <span className="text-[#505050]">X:</span>
                  <span className="text-[#a0a0a0] ml-1">
                    {THREE.MathUtils.radToDeg(rot.x).toFixed(0)}°
                  </span>
                </div>
                <div>
                  <span className="text-[#505050]">Y:</span>
                  <span className="text-[#a0a0a0] ml-1">
                    {THREE.MathUtils.radToDeg(rot.y).toFixed(0)}°
                  </span>
                </div>
                <div>
                  <span className="text-[#505050]">Z:</span>
                  <span className="text-[#a0a0a0] ml-1">
                    {THREE.MathUtils.radToDeg(rot.z).toFixed(0)}°
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { label: 'X', rotate: rotateX },
                  { label: 'Y', rotate: rotateY },
                  { label: 'Z', rotate: rotateZ },
                ].map(({ label, rotate }) => (
                  <div key={label} className="flex gap-0.5">
                    <button
                      onClick={() => rotate(-1)}
                      className="flex-1 py-1 bg-[#0e0e0e] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                    >
                      ↺{label}
                    </button>
                    <button
                      onClick={() => rotate(1)}
                      className="flex-1 py-1 bg-[#0e0e0e] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                    >
                      ↻{label}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Scale Controls */}
            <div className="p-2 bg-[#0a0a0a] border border-[#1a1a1a]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[0.75em] text-[#606060] tracking-wider">SKALIERUNG</span>
                <button
                  onClick={resetScale}
                  className="text-[0.625em] text-[#505050] hover:text-[#808080] px-1"
                >
                  RESET
                </button>
              </div>
              <div className="text-[0.875em] text-[#a0a0a0] mb-2">
                {scl.x.toFixed(2)} x {scl.y.toFixed(2)} x {scl.z.toFixed(2)}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => scaleUniform(-1)}
                  className="flex-1 py-1.5 bg-[#0e0e0e] border border-[#252525] text-[1.25em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                >
                  −
                </button>
                <button
                  onClick={() => scaleUniform(1)}
                  className="flex-1 py-1.5 bg-[#0e0e0e] border border-[#252525] text-[1.25em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
                >
                  +
                </button>
              </div>
            </div>

            {/* Delete Button */}
            <button
              onClick={handleDelete}
              className="w-full py-2 bg-[#1a0808] border border-[#3a2020] text-[0.875em] text-[#8b4a4a] hover:border-[#5a3030] hover:text-[#a06060] tracking-wider"
            >
              ENTFERNEN
            </button>

            {/* Keyboard hints */}
            <div className="text-[0.625em] text-[#404040] space-y-0.5">
              <div>ROT: I/K J/L U/O</div>
              <div>SKAL: +/−</div>
              <div>LÖSCHEN: ⌫</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ObjectTransformControls
