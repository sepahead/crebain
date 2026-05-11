/**
 * CREBAIN useROSCamera Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for streaming Gazebo camera feeds via ROS
 * Provides decoded frames as ImageBitmap/ImageData for rendering
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ROSBridge } from './ROSBridge'
import type { ZenohBridge } from './ZenohBridge'
import type { CameraInfo } from './types'
import {
  ROSCameraStream,
  type DecodedFrame,
  type CameraStreamConfig,
  type CameraStreamStats,
} from './ROSCameraStream'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface UseROSCameraConfig extends Partial<CameraStreamConfig> {
  /** Drone namespace (e.g., '/drone1') */
  namespace?: string
  /** Camera name (e.g., 'front_camera') */
  cameraName?: string
  /** Enable streaming */
  enabled?: boolean
}

export interface UseROSCameraResult {
  /** Latest decoded frame */
  frame: DecodedFrame | null
  /** Camera intrinsics */
  cameraInfo: CameraInfo | null
  /** Streaming statistics */
  stats: CameraStreamStats
  /** Whether currently receiving frames */
  isStreaming: boolean
  /** Any error that occurred */
  error: Error | null
  /** Manually trigger a frame request */
  requestFrame: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook for subscribing to ROS camera topics from Gazebo
 *
 * @example
 * ```tsx
 * function DroneCamera({ bridge, droneId }: Props) {
 *   const { frame, stats, isStreaming } = useROSCamera(bridge, {
 *     namespace: `/drone${droneId}`,
 *     cameraName: 'front_camera',
 *     enabled: true,
 *   })
 *
 *   // Render frame to canvas or Three.js texture
 *   useEffect(() => {
 *     if (!frame || !canvasRef.current) return
 *     const ctx = canvasRef.current.getContext('2d')!
 *     if (frame.image instanceof ImageBitmap) {
 *       ctx.drawImage(frame.image, 0, 0)
 *     } else {
 *       ctx.putImageData(frame.image, 0, 0)
 *     }
 *   }, [frame])
 *
 *   return (
 *     <canvas ref={canvasRef} width={frame?.width ?? 640} height={frame?.height ?? 480} />
 *   )
 * }
 * ```
 */
export function useROSCamera(
  bridge: ROSBridge | ZenohBridge | null,
  config: UseROSCameraConfig = {}
): UseROSCameraResult {
  const {
    namespace = '',
    cameraName = 'camera',
    enabled = true,
    compressedTopic,
    rawTopic,
    infoTopic,
    throttleMs = 33,
    queueLength = 1,
    useImageBitmap = true,
  } = config

  const [frame, setFrame] = useState<DecodedFrame | null>(null)
  const [cameraInfo, setCameraInfo] = useState<CameraInfo | null>(null)
  const [stats, setStats] = useState<CameraStreamStats>({
    framesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    averageDecodeMs: 0,
    averageLatencyMs: 0,
    currentFps: 0,
  })
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const streamRef = useRef<ROSCameraStream | null>(null)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Build topic paths
  const topicConfig = {
    compressedTopic: compressedTopic ?? `${cameraName}/image_raw/compressed`,
    rawTopic: rawTopic ?? `${cameraName}/image_raw`,
    infoTopic: infoTopic ?? `${cameraName}/camera_info`,
    throttleMs,
    queueLength,
    useImageBitmap,
  }

  // Stable config ref to avoid effect re-runs
  const configRef = useRef(topicConfig)
  configRef.current = topicConfig

  useEffect(() => {
    if (!bridge || !enabled) {
      streamRef.current?.stop()
      streamRef.current = null
      setIsStreaming(false)
      return
    }

    // Create camera stream
    const stream = new ROSCameraStream(configRef.current)
    streamRef.current = stream

    // Handle frames
    const unsubFrame = stream.onFrame((decodedFrame) => {
      setFrame(decodedFrame)
      setIsStreaming(true)
      setError(null)
    })

    // Handle camera info
    const unsubInfo = stream.onCameraInfo((info) => {
      setCameraInfo(info)
    })

    // Start streaming
    try {
      stream.start(bridge, namespace)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsStreaming(false)
    }

    // Poll stats periodically
    statsIntervalRef.current = setInterval(() => {
      if (streamRef.current) {
        setStats({ ...streamRef.current.getStats() })
      }
    }, 1000)

    return () => {
      unsubFrame()
      unsubInfo()
      stream.stop()
      streamRef.current = null
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current)
        statsIntervalRef.current = null
      }
      setIsStreaming(false)
    }
  }, [bridge, namespace, enabled])

  const requestFrame = useCallback(() => {
    const err = new Error('Manual ROS frame requests are not supported by the streaming camera hook')
    setError(err)
    throw err
  }, [])

  return {
    frame,
    cameraInfo,
    stats,
    isStreaming,
    error,
    requestFrame,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXTURE HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a Three.js texture from a decoded frame
 * Call this in your render loop or effect when frame changes
 */
export function updateTextureFromFrame(
  texture: THREE.Texture,
  frame: DecodedFrame
): void {
  if (frame.image instanceof ImageBitmap) {
    // ImageBitmap can be used directly as texture source
    texture.image = frame.image
    texture.needsUpdate = true
  } else {
    // ImageData needs a canvas intermediate
    const canvas = document.createElement('canvas')
    canvas.width = frame.width
    canvas.height = frame.height
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(frame.image, 0, 0)
    texture.image = canvas
    texture.needsUpdate = true
  }
}

// TypeScript helper for THREE import
declare namespace THREE {
  interface Texture {
    image: unknown
    needsUpdate: boolean
  }
}
