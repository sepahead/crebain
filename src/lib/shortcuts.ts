export const APP_SHORTCUTS = {
  togglePerformancePanel: 'p',
  toggleROSPanel: 'n',
  toggleFusionPanel: 'u',
} as const

export const VIEWER_SHORTCUTS = {
  resetCamera: 'r',
  focusContent: 'f',
  toggleGrid: 'g',
  placeStaticCamera: '1',
  placePTZCamera: '2',
  placePatrolCamera: '3',
  toggleCameraFeeds: 'v',
  toggleDetectionPanel: 't',
  toggleDetectionEnabled: 'y',
  cycleCamera: 'tab',
  cancelSelection: 'escape',
} as const

export function normalizeShortcutKey(key: string): string {
  return key.toLowerCase()
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}
