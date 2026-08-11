import type { KeyboardEvent } from 'react'

const MINIMUM_SCROLL_STEP_PX = 80
const VIEWPORT_SCROLL_FRACTION = 0.8

/**
 * Give a focused, horizontally overflowing status region deterministic
 * keyboard navigation without intercepting keys from its child controls.
 */
export function handleHorizontalScrollKeyDown<T extends HTMLElement>(
  event: KeyboardEvent<T>
): void {
  if (event.target !== event.currentTarget) return

  const region = event.currentTarget
  const maximum = Math.max(0, region.scrollWidth - region.clientWidth)
  const step = Math.max(MINIMUM_SCROLL_STEP_PX, region.clientWidth * VIEWPORT_SCROLL_FRACTION)
  let next: number

  switch (event.key) {
    case 'ArrowLeft':
      next = region.scrollLeft - step
      break
    case 'ArrowRight':
      next = region.scrollLeft + step
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = maximum
      break
    default:
      return
  }

  event.preventDefault()
  region.scrollLeft = Math.max(0, Math.min(maximum, next))
}

/**
 * Give a focused, vertically overflowing overlay rail deterministic keyboard
 * navigation without intercepting keys from controls inside the rail.
 */
export function handleVerticalScrollKeyDown<T extends HTMLElement>(event: KeyboardEvent<T>): void {
  if (event.target !== event.currentTarget) return

  const region = event.currentTarget
  const maximum = Math.max(0, region.scrollHeight - region.clientHeight)
  const step = Math.max(MINIMUM_SCROLL_STEP_PX, region.clientHeight * VIEWPORT_SCROLL_FRACTION)
  let next: number

  switch (event.key) {
    case 'ArrowUp':
      next = region.scrollTop - step
      break
    case 'ArrowDown':
      next = region.scrollTop + step
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = maximum
      break
    default:
      return
  }

  event.preventDefault()
  region.scrollTop = Math.max(0, Math.min(maximum, next))
}
