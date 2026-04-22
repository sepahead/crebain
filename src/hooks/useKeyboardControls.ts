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

export interface KeyboardState {
  // Movement
  forward: boolean    // W
  backward: boolean   // S
  left: boolean       // A
  right: boolean      // D
  yawLeft: boolean    // Q
  yawRight: boolean   // E
  up: boolean         // Space
  down: boolean       // Shift
  
  // Actions
  arm: boolean        // R (toggle)
  emergency: boolean  // Escape
  
  // Camera/View
  cameraSwitch: boolean  // C
  
  // Raw key state for debugging
  activeKeys: Set<string>
}

export interface DroneControlInput {
  pitch: number      // -1 to 1 (forward/backward)
  roll: number       // -1 to 1 (left/right)
  yaw: number        // -1 to 1 (rotate left/right)
  throttle: number   // 0 to 1 (up/down)
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
  const { enabled = true, onArm, onDisarm, onEmergency, sensitivity = 0.6, smoothingFactor = 0.15 } = options
  
  const [keyState, setKeyState] = useState<KeyboardState>(createDefaultState)
  const armedRef = useRef(false)
  const baseThrottleRef = useRef(0.5) // Hover throttle
  
  const smoothedInputRef = useRef({ pitch: 0, roll: 0, yaw: 0 })
  
  // Handle keydown
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return
    
    // Ignore if typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return
    }
    
    const key = e.key.toLowerCase()
    
    setKeyState(prev => {
      const newKeys = new Set(prev.activeKeys)
      newKeys.add(key)
      
      const newState = { ...prev, activeKeys: newKeys }
      
      switch (key) {
        case 'w': newState.forward = true; break
        case 's': newState.backward = true; break
        case 'a': newState.left = true; break
        case 'd': newState.right = true; break
        case 'q': newState.yawLeft = true; break
        case 'e': newState.yawRight = true; break
        case ' ': newState.up = true; e.preventDefault(); break
        case 'shift': newState.down = true; break
        case 'c': newState.cameraSwitch = true; break
        case 'escape':
          newState.emergency = true
          onEmergency?.()
          break
        case 'r':
          // Toggle arm state
          armedRef.current = !armedRef.current
          newState.arm = armedRef.current
          if (armedRef.current) {
            onArm?.()
          } else {
            onDisarm?.()
          }
          break
      }
      
      return newState
    })
  }, [enabled, onArm, onDisarm, onEmergency])
  
  // Handle keyup
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (!enabled) return
    
    const key = e.key.toLowerCase()
    
    setKeyState(prev => {
      const newKeys = new Set(prev.activeKeys)
      newKeys.delete(key)
      
      const newState = { ...prev, activeKeys: newKeys }
      
      switch (key) {
        case 'w': newState.forward = false; break
        case 's': newState.backward = false; break
        case 'a': newState.left = false; break
        case 'd': newState.right = false; break
        case 'q': newState.yawLeft = false; break
        case 'e': newState.yawRight = false; break
        case ' ': newState.up = false; break
        case 'shift': newState.down = false; break
        case 'c': newState.cameraSwitch = false; break
        case 'escape': newState.emergency = false; break
      }
      
      return newState
    })
  }, [enabled])
  
  // Register event listeners
  useEffect(() => {
    if (!enabled) return
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [enabled, handleKeyDown, handleKeyUp])
  
  // Convert key state to drone control input with smoothing
  // Track last call time to prevent throttle ramping at multiples of intended rate
  // when getControlInput is called more than once per frame.
  const lastThrottleUpdateRef = useRef(0)
  const getControlInput = useCallback((): DroneControlInput => {
    let targetPitch = 0
    let targetRoll = 0
    let targetYaw = 0
    let throttle = baseThrottleRef.current
    
    // Pitch (forward/backward)
    if (keyState.forward) targetPitch += sensitivity
    if (keyState.backward) targetPitch -= sensitivity
    
    // Roll (left/right)
    if (keyState.left) targetRoll -= sensitivity
    if (keyState.right) targetRoll += sensitivity
    
    // Yaw (rotate)
    if (keyState.yawLeft) targetYaw -= sensitivity
    if (keyState.yawRight) targetYaw += sensitivity
    
    // Throttle — only mutate once per frame to avoid compounding on multiple calls
    const now = performance.now()
    if (now - lastThrottleUpdateRef.current > 8) { // ~120fps guard
      lastThrottleUpdateRef.current = now
      if (keyState.up) {
        baseThrottleRef.current = Math.min(1, baseThrottleRef.current + 0.01)
      }
      if (keyState.down) {
        baseThrottleRef.current = Math.max(0, baseThrottleRef.current - 0.01)
      }
    }
    throttle = baseThrottleRef.current
    
    // Apply smoothing (exponential moving average)
    // When no key pressed, decay quickly to 0
    const decayFactor = 0.25
    const rampFactor = smoothingFactor
    
    smoothedInputRef.current.pitch += (targetPitch - smoothedInputRef.current.pitch) * 
      (targetPitch === 0 ? decayFactor : rampFactor)
    smoothedInputRef.current.roll += (targetRoll - smoothedInputRef.current.roll) * 
      (targetRoll === 0 ? decayFactor : rampFactor)
    smoothedInputRef.current.yaw += (targetYaw - smoothedInputRef.current.yaw) * 
      (targetYaw === 0 ? decayFactor : rampFactor)
    
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
    setKeyState(prev => ({ ...prev, arm: armed }))
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
