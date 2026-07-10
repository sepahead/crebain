/**
 * CREBAIN Draggable Panel Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Provides drag functionality with edge snapping and bounds constraints
 */

import { useState, useRef, useEffect, useCallback } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface Position {
  x: number
  y: number
}

export interface DraggableConfig {
  /** Initial position */
  initialPosition: Position
  /** Snap distance to edges in pixels */
  snapDistance?: number
  /** Padding from screen edges */
  edgePadding?: number
  /** Header height offset for top constraint */
  headerHeight?: number
  /** Which side the panel is anchored to ('left' or 'right') */
  side?: 'left' | 'right'
  /** Element width (for right/bottom bounds) */
  elementWidth?: number
  /** Element height (for right/bottom bounds) */
  elementHeight?: number
}

export interface DraggableReturn {
  /** Current position */
  position: Position
  /** Whether currently dragging */
  isDragging: boolean
  /** Whether the last interaction was a drag (not a click) */
  wasDragged: boolean
  /** Mouse down handler for the drag handle */
  handleMouseDown: (e: React.MouseEvent) => void
  /** Ref to attach to the draggable element for size tracking */
  elementRef: React.RefObject<HTMLDivElement | null>
  /** Whether position was snapped to an edge */
  isSnapped: {
    left: boolean
    right: boolean
    top: boolean
    bottom: boolean
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useDraggable(config: DraggableConfig): DraggableReturn {
  const {
    initialPosition,
    snapDistance = 20,
    edgePadding = 12, // Same padding for both left and right edges
    headerHeight = 68,
    side = 'right',
  } = config

  const [position, setPosition] = useState<Position>(initialPosition)
  const [isDragging, setIsDragging] = useState(false)
  const [wasDragged, setWasDragged] = useState(false)
  const [isSnapped, setIsSnapped] = useState({
    left: side === 'left', // Start snapped based on side
    right: side === 'right',
    top: false,
    bottom: false,
  })

  const dragStartPos = useRef<Position>({ x: 0, y: 0 })
  const elementStartPos = useRef<Position>({ x: 0, y: 0 })
  const elementRef = useRef<HTMLDivElement>(null)
  const dragThreshold = useRef(false) // Track if we've moved enough to be considered a drag

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only drag from elements with data-drag-handle attribute
      const target = e.target as HTMLElement
      if (!target.closest('[data-drag-handle]')) return
      if (target.closest('button, input, select, textarea, a, [role="button"]')) return

      e.preventDefault()
      e.stopPropagation()

      setIsDragging(true)
      setWasDragged(false) // Reset wasDragged on new interaction
      dragThreshold.current = false // Reset drag threshold
      dragStartPos.current = { x: e.clientX, y: e.clientY }
      elementStartPos.current = { x: position.x, y: position.y }
    },
    [position]
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartPos.current.x
      const deltaY = e.clientY - dragStartPos.current.y

      // Check if we've moved enough to be considered a drag (prevents accidental drags on click)
      if (!dragThreshold.current && Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) {
        return
      }
      dragThreshold.current = true

      let newX = elementStartPos.current.x + deltaX
      let newY = elementStartPos.current.y + deltaY

      // Get viewport dimensions
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      // Get element dimensions
      const elementWidth = elementRef.current?.offsetWidth ?? 300
      const elementHeight = elementRef.current?.offsetHeight ?? 200

      // Calculate bounds based on which side the panel is anchored to
      let minX: number, maxX: number

      if (side === 'left') {
        // For left-side panels: position.x is offset from left edge
        minX = edgePadding // At left edge
        maxX = viewportWidth - elementWidth - edgePadding // Max right
      } else {
        // For right-side panels: position.x is a transform offset
        // Base position is CSS `right: 12px` (from right-3 class)
        // When x=0, panel right edge is 12px from viewport right
        // Panel left edge is at: viewportWidth - 12 - elementWidth
        //
        // To move left edge to edgePadding:
        //   edgePadding = viewportWidth - 12 - elementWidth + minX
        //   minX = edgePadding - viewportWidth + 12 + elementWidth
        //   minX = -(viewportWidth - elementWidth - edgePadding - 12)
        const rightOffset = 12 // Matches right-3 Tailwind class
        minX = -(viewportWidth - elementWidth - edgePadding - rightOffset)
        maxX = 0 // At right edge (snapped to right with rightOffset from CSS)
      }

      const minY = edgePadding + headerHeight // Below header
      const maxY = viewportHeight - elementHeight - edgePadding

      // Constrain to bounds
      newX = Math.max(minX, Math.min(maxX, newX))
      newY = Math.max(minY, Math.min(maxY, newY))

      // Calculate snap states
      // Snapping occurs when position is within snapDistance of the boundary
      const snapped = {
        left: newX <= minX + snapDistance,
        right: newX >= maxX - snapDistance,
        top: newY <= minY + snapDistance,
        bottom: newY >= maxY - snapDistance,
      }

      // Apply snapping
      if (snapped.left) newX = minX
      if (snapped.right) newX = maxX
      if (snapped.top) newY = minY
      if (snapped.bottom) newY = maxY

      setIsSnapped(snapped)
      setPosition({ x: newX, y: newY })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setWasDragged(dragThreshold.current) // Set wasDragged based on whether we actually moved
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, snapDistance, edgePadding, headerHeight, side])

  // Keep panels reachable after viewport or panel-size changes. Drag clamping
  // alone is insufficient: a panel positioned for a large window can otherwise
  // remain entirely off-screen after resize or expansion.
  useEffect(() => {
    const clampToViewport = () => {
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const elementWidth = elementRef.current?.offsetWidth ?? 300
      const elementHeight = elementRef.current?.offsetHeight ?? 200
      const minY = edgePadding + headerHeight
      const maxY = Math.max(minY, viewportHeight - elementHeight - edgePadding)
      const rightOffset = 12
      const minX =
        side === 'left'
          ? edgePadding
          : Math.min(0, -(viewportWidth - elementWidth - edgePadding - rightOffset))
      const maxX = side === 'left' ? Math.max(minX, viewportWidth - elementWidth - edgePadding) : 0

      setPosition((current) => ({
        x: Math.max(minX, Math.min(maxX, current.x)),
        y: Math.max(minY, Math.min(maxY, current.y)),
      }))
    }

    clampToViewport()
    window.addEventListener('resize', clampToViewport)
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampToViewport)
    if (elementRef.current) resizeObserver?.observe(elementRef.current)

    return () => {
      window.removeEventListener('resize', clampToViewport)
      resizeObserver?.disconnect()
    }
  }, [edgePadding, headerHeight, side])

  return {
    position,
    isDragging,
    wasDragged,
    handleMouseDown,
    elementRef,
    isSnapped,
  }
}

export default useDraggable
