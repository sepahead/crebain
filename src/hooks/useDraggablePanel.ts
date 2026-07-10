/**
 * CREBAIN Draggable Panel Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Combines useDraggable with header click/expand toggle handling.
 * Eliminates duplicate wasDragged tracking pattern across all panel components.
 */

import { useRef, useCallback } from 'react'
import { useDraggable, type DraggableConfig, type Position } from './useDraggable'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface DraggablePanelConfig extends DraggableConfig {
  /** Callback when header is clicked (not dragged) - typically toggles expand */
  onHeaderClick?: () => void
}

export interface DraggablePanelReturn {
  /** Current position */
  position: Position
  /** Whether currently dragging */
  isDragging: boolean
  /** Mouse down handler for the drag handle */
  handleMouseDown: (e: React.MouseEvent) => void
  /** Click handler for the header - only fires if not dragged */
  handleHeaderClick: () => void
  /** Ref to attach to the draggable element for size tracking */
  elementRef: React.RefObject<HTMLDivElement | null>
  /** Whether position was snapped to an edge */
  isSnapped: {
    left: boolean
    right: boolean
    top: boolean
    bottom: boolean
  }
  /** Common panel style object with position and cursor */
  panelStyle: React.CSSProperties
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Base font size calculation for scaled panels */
export const PANEL_FONT_SIZE = 'max(12px, calc(12px * var(--ui-scale, 1)))'

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useDraggablePanel(config: DraggablePanelConfig): DraggablePanelReturn {
  const { onHeaderClick, ...draggableConfig } = config

  // Get base draggable functionality
  const { position, isDragging, wasDragged, handleMouseDown, elementRef, isSnapped } =
    useDraggable(draggableConfig)

  // Track wasDragged in a ref for stable click detection
  // This syncs on each render to capture the latest value
  const lastWasDraggedRef = useRef(false)
  if (wasDragged !== lastWasDraggedRef.current) {
    lastWasDraggedRef.current = wasDragged
  }

  // Header click handler - only triggers if not dragged
  const handleHeaderClick = useCallback(() => {
    if (!lastWasDraggedRef.current) {
      onHeaderClick?.()
    }
    // Reset after handling to prepare for next interaction
    lastWasDraggedRef.current = false
  }, [onHeaderClick])

  // Compute panel style based on position and side
  const panelStyle: React.CSSProperties =
    config.side === 'right'
      ? {
          top: `${position.y}px`,
          transform: `translateX(${position.x}px)`,
          cursor: isDragging ? 'grabbing' : undefined,
          fontSize: PANEL_FONT_SIZE,
        }
      : {
          left: `${position.x}px`,
          top: `${position.y}px`,
          cursor: isDragging ? 'grabbing' : undefined,
          fontSize: PANEL_FONT_SIZE,
        }

  return {
    position,
    isDragging,
    handleMouseDown,
    handleHeaderClick,
    elementRef,
    isSnapped,
    panelStyle,
  }
}

export default useDraggablePanel
