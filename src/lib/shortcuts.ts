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
  toggleSplatPerformanceMode: 'm',
  cycleCamera: 'tab',
  cancelSelection: 'escape',
} as const

export const DRONE_CONTROL_SHORTCUTS = {
  forward: 'w',
  backward: 's',
  left: 'a',
  right: 'd',
  yawLeft: 'q',
  yawRight: 'e',
  up: ' ',
  down: 'shift',
  cameraSwitch: 'c',
  armToggle: 'r',
  emergency: 'escape',
} as const

export function normalizeShortcutKey(key: string): string {
  return key.toLowerCase()
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}
