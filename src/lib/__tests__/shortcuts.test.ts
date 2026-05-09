import { describe, it, expect } from 'vitest'
import { APP_SHORTCUTS, VIEWER_SHORTCUTS, isTextInputTarget, normalizeShortcutKey } from '../shortcuts'

describe('shortcuts', () => {
  it('keeps app panel shortcuts centralized', () => {
    expect(APP_SHORTCUTS.togglePerformancePanel).toBe('p')
    expect(APP_SHORTCUTS.toggleROSPanel).toBe('n')
    expect(APP_SHORTCUTS.toggleFusionPanel).toBe('u')
  })

  it('keeps viewer shortcuts aligned with documented behavior', () => {
    expect(VIEWER_SHORTCUTS.toggleCameraFeeds).toBe('v')
    expect(VIEWER_SHORTCUTS.toggleDetectionPanel).toBe('t')
    expect(VIEWER_SHORTCUTS.toggleDetectionEnabled).toBe('y')
    expect(VIEWER_SHORTCUTS.focusContent).toBe('f')
    expect(VIEWER_SHORTCUTS.toggleGrid).toBe('g')
  })

  it('normalizes keyboard keys', () => {
    expect(normalizeShortcutKey('P')).toBe('p')
    expect(normalizeShortcutKey('Tab')).toBe('tab')
    expect(normalizeShortcutKey('Escape')).toBe('escape')
  })

  it('detects text input targets', () => {
    expect(isTextInputTarget(document.createElement('input'))).toBe(true)
    expect(isTextInputTarget(document.createElement('textarea'))).toBe(true)
    expect(isTextInputTarget(document.createElement('div'))).toBe(false)
    expect(isTextInputTarget(null)).toBe(false)
  })
})
