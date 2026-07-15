/**
 * CREBAIN Keyboard Controls Hook
 * WASD controls for drone flight with additional keys for altitude and yaw
 *
 * Controls:
 * - W/S: Pitch forward/backward
 * - A/D: Roll left/right
 * - Q/E: Yaw left/right
 * - Space: Increase altitude (throttle up)
 * - Shift: Decrease altitude (throttle down)
 * - R: Arm/disarm toggle
 * - Escape: Emergency stop
 */

import { useEffect, useCallback, useRef, useState } from 'react'
import { DRONE_CONTROL_SHORTCUTS, isTextInputTarget, normalizeShortcutKey } from '../lib/shortcuts'

export interface KeyboardState {
  // Movement
  forward: boolean // W
  backward: boolean // S
  left: boolean // A
  right: boolean // D
  yawLeft: boolean // Q
  yawRight: boolean // E
  up: boolean // Space
  down: boolean // Shift

  // Actions
  arm: boolean // R (toggle)
  emergency: boolean // Escape

  // Camera/View
  cameraSwitch: boolean // C

  // Raw key state for debugging
  activeKeys: Set<string>
}

export interface DroneControlInput {
  pitch: number // -1 to 1 (forward/backward)
  roll: number // -1 to 1 (left/right)
  yaw: number // -1 to 1 (rotate left/right)
  throttle: number // 0 to 1 (up/down)
}

const REFERENCE_CONTROL_RATE_HZ = 60
const REFERENCE_CONTROL_STEP_SECONDS = 1 / REFERENCE_CONTROL_RATE_HZ
const THROTTLE_CHANGE_PER_SECOND = 0.6
const MAX_CONTROL_STEP_SECONDS = 0.1
const INPUT_DECAY_PER_REFERENCE_STEP = 0.25

function elapsedControlSeconds(previousMs: number | null, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0
  if (previousMs === null) return REFERENCE_CONTROL_STEP_SECONDS
  if (!Number.isFinite(previousMs) || nowMs <= previousMs) return 0
  return Math.min((nowMs - previousMs) / 1000, MAX_CONTROL_STEP_SECONDS)
}

function timeAdjustedFactor(perReferenceStep: number, elapsedSeconds: number): number {
  if (!Number.isFinite(perReferenceStep) || perReferenceStep <= 0 || elapsedSeconds <= 0) return 0
  if (perReferenceStep >= 1) return 1
  return 1 - Math.pow(1 - perReferenceStep, elapsedSeconds * REFERENCE_CONTROL_RATE_HZ)
}

const createDefaultState = (): KeyboardState => ({
  forward: false,
  backward: false,
  left: false,
  right: false,
  yawLeft: false,
  yawRight: false,
  up: false,
  down: false,
  arm: false,
  emergency: false,
  cameraSwitch: false,
  activeKeys: new Set(),
})

interface UseKeyboardControlsOptions {
  enabled?: boolean
  onArm?: () => void
  onDisarm?: () => void
  onEmergency?: () => void
  sensitivity?: number
  smoothingFactor?: number
}

export function useKeyboardControls(options: UseKeyboardControlsOptions = {}) {
  const {
    enabled = true,
    onArm,
    onDisarm,
    onEmergency,
    sensitivity = 0.6,
    smoothingFactor = 0.15,
  } = options

  const [keyState, setKeyState] = useState<KeyboardState>(createDefaultState)
  const armedRef = useRef(false)
  const baseThrottleRef = useRef(0.5) // Hover throttle
  const smoothedInputRef = useRef({ pitch: 0, roll: 0, yaw: 0 })
  const lastControlUpdateRef = useRef<number | null>(null)

  const clearTransientControls = useCallback(() => {
    smoothedInputRef.current = { pitch: 0, roll: 0, yaw: 0 }
    baseThrottleRef.current = 0.5
    lastControlUpdateRef.current = null
    setKeyState({ ...createDefaultState(), arm: armedRef.current })
  }, [])

  // Handle keydown
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore OS key auto-repeat: the key is already marked active by the first
      // keydown, so repeats only churn keyState identity (re-rendering consumers
      // and re-subscribing the physics rAF loop in useDroneController).
      if (e.repeat) return

      const key = normalizeShortcutKey(e.key)

      // Emergency stop is global: it must remain available when flight controls
      // are disabled, no drone is selected, or focus is inside a form field.
      if (key === DRONE_CONTROL_SHORTCUTS.emergency) {
        setKeyState((prev) => ({
          ...prev,
          emergency: true,
          activeKeys: new Set(prev.activeKeys).add(key),
        }))
        onEmergency?.()
        return
      }

      if (!enabled || isTextInputTarget(e.target)) return

      if (key === DRONE_CONTROL_SHORTCUTS.up) e.preventDefault()

      let nextArmed: boolean | undefined
      if (key === DRONE_CONTROL_SHORTCUTS.armToggle) {
        nextArmed = !armedRef.current
        armedRef.current = nextArmed
      }

      setKeyState((prev) => {
        const newKeys = new Set(prev.activeKeys)
        newKeys.add(key)

        const newState = { ...prev, activeKeys: newKeys }

        switch (key) {
          case DRONE_CONTROL_SHORTCUTS.forward:
            newState.forward = true
            break
          case DRONE_CONTROL_SHORTCUTS.backward:
            newState.backward = true
            break
          case DRONE_CONTROL_SHORTCUTS.left:
            newState.left = true
            break
          case DRONE_CONTROL_SHORTCUTS.right:
            newState.right = true
            break
          case DRONE_CONTROL_SHORTCUTS.yawLeft:
            newState.yawLeft = true
            break
          case DRONE_CONTROL_SHORTCUTS.yawRight:
            newState.yawRight = true
            break
          case DRONE_CONTROL_SHORTCUTS.up:
            newState.up = true
            break
          case DRONE_CONTROL_SHORTCUTS.down:
            newState.down = true
            break
          case DRONE_CONTROL_SHORTCUTS.cameraSwitch:
            newState.cameraSwitch = true
            break
          case DRONE_CONTROL_SHORTCUTS.armToggle:
            newState.arm = nextArmed ?? prev.arm
            break
        }

        return newState
      })

      // User callbacks are effects, so keep them outside React's state updater.
      // Strict Mode is allowed to invoke updater functions more than once.
      if (nextArmed === true) onArm?.()
      if (nextArmed === false) onDisarm?.()
    },
    [enabled, onArm, onDisarm, onEmergency]
  )

  // Handle keyup
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      const key = normalizeShortcutKey(e.key)

      // Always release the global emergency key, including after controls were
      // disabled between keydown and keyup.
      if (key === DRONE_CONTROL_SHORTCUTS.emergency) {
        setKeyState((prev) => {
          const newKeys = new Set(prev.activeKeys)
          newKeys.delete(key)
          return { ...prev, emergency: false, activeKeys: newKeys }
        })
        return
      }

      if (!enabled) return

      setKeyState((prev) => {
        const newKeys = new Set(prev.activeKeys)
        newKeys.delete(key)

        const newState = { ...prev, activeKeys: newKeys }

        switch (key) {
          case DRONE_CONTROL_SHORTCUTS.forward:
            newState.forward = false
            break
          case DRONE_CONTROL_SHORTCUTS.backward:
            newState.backward = false
            break
          case DRONE_CONTROL_SHORTCUTS.left:
            newState.left = false
            break
          case DRONE_CONTROL_SHORTCUTS.right:
            newState.right = false
            break
          case DRONE_CONTROL_SHORTCUTS.yawLeft:
            newState.yawLeft = false
            break
          case DRONE_CONTROL_SHORTCUTS.yawRight:
            newState.yawRight = false
            break
          case DRONE_CONTROL_SHORTCUTS.up:
            newState.up = false
            break
          case DRONE_CONTROL_SHORTCUTS.down:
            newState.down = false
            break
          case DRONE_CONTROL_SHORTCUTS.cameraSwitch:
            newState.cameraSwitch = false
            break
        }

        return newState
      })
    },
    [enabled]
  )

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === 'hidden') clearTransientControls()
  }, [clearTransientControls])

  // Register global safety listeners. Key listeners stay active while normal
  // controls are disabled so Escape can always trigger the emergency callback.
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearTransientControls)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearTransientControls)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [clearTransientControls, handleKeyDown, handleKeyUp, handleVisibilityChange])

  useEffect(() => {
    if (!enabled) clearTransientControls()
  }, [clearTransientControls, enabled])

  // Convert key state to time-based drone control input. Both throttle and
  // smoothing are integrated by monotonic elapsed time, so a 30 Hz and a
  // 144 Hz render loop produce the same command trajectory.
  const getControlInput = useCallback((): DroneControlInput => {
    let targetPitch = 0
    let targetRoll = 0
    let targetYaw = 0

    // Pitch (forward/backward)
    if (keyState.forward) targetPitch += sensitivity
    if (keyState.backward) targetPitch -= sensitivity

    // Roll (left/right)
    if (keyState.left) targetRoll -= sensitivity
    if (keyState.right) targetRoll += sensitivity

    // Yaw (rotate)
    if (keyState.yawLeft) targetYaw -= sensitivity
    if (keyState.yawRight) targetYaw += sensitivity

    const now = performance.now()
    const elapsedSeconds = elapsedControlSeconds(lastControlUpdateRef.current, now)
    lastControlUpdateRef.current = Number.isFinite(now) ? now : null

    // Throttle changes at a fixed rate per second rather than per callback.
    const throttleDirection = Number(keyState.up) - Number(keyState.down)
    baseThrottleRef.current = Math.max(
      0,
      Math.min(
        1,
        baseThrottleRef.current + throttleDirection * THROTTLE_CHANGE_PER_SECOND * elapsedSeconds
      )
    )
    let throttle = baseThrottleRef.current

    // Preserve the configured 60 Hz response while making the exponential
    // smoothing coefficient independent of actual callback frequency.
    const rampFactor = timeAdjustedFactor(smoothingFactor, elapsedSeconds)
    const decayFactor = timeAdjustedFactor(INPUT_DECAY_PER_REFERENCE_STEP, elapsedSeconds)

    smoothedInputRef.current.pitch +=
      (targetPitch - smoothedInputRef.current.pitch) *
      (targetPitch === 0 ? decayFactor : rampFactor)
    smoothedInputRef.current.roll +=
      (targetRoll - smoothedInputRef.current.roll) * (targetRoll === 0 ? decayFactor : rampFactor)
    smoothedInputRef.current.yaw +=
      (targetYaw - smoothedInputRef.current.yaw) * (targetYaw === 0 ? decayFactor : rampFactor)

    // Snap to zero when very small to prevent drift
    if (Math.abs(smoothedInputRef.current.pitch) < 0.01) smoothedInputRef.current.pitch = 0
    if (Math.abs(smoothedInputRef.current.roll) < 0.01) smoothedInputRef.current.roll = 0
    if (Math.abs(smoothedInputRef.current.yaw) < 0.01) smoothedInputRef.current.yaw = 0

    // Clamp values
    const pitch = Math.max(-1, Math.min(1, smoothedInputRef.current.pitch))
    const roll = Math.max(-1, Math.min(1, smoothedInputRef.current.roll))
    const yaw = Math.max(-1, Math.min(1, smoothedInputRef.current.yaw))
    throttle = Math.max(0, Math.min(1, throttle))

    return { pitch, roll, yaw, throttle }
  }, [keyState, sensitivity, smoothingFactor])

  // Reset throttle to hover
  const resetThrottle = useCallback(() => {
    baseThrottleRef.current = 0.5
  }, [])

  // Set armed state programmatically
  const setArmed = useCallback((armed: boolean) => {
    armedRef.current = armed
    setKeyState((prev) => ({ ...prev, arm: armed }))
  }, [])

  return {
    keyState,
    isArmed: armedRef.current,
    getControlInput,
    resetThrottle,
    setArmed,
  }
}

export default useKeyboardControls
