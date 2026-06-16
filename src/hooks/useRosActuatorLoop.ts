/**
 * CREBAIN ROS Actuator Loop Hook
 * Rate-limited motor command publishing for drone control
 */

import { useEffect, useRef, useState } from 'react'
import { getROSBridge } from '../ros/ROSBridge'
import type { DronePhysicsWorld } from '../physics/DronePhysics'

export interface ActuatorLoopConfig {
  rateHz?: number
  maxRPM?: number
  enabled?: boolean
}

export interface UseRosActuatorLoopReturn {
  isRunning: boolean
  commandsSent: number
  lastError: string | null
}

const DEFAULT_CONFIG: Required<ActuatorLoopConfig> = {
  rateHz: 50,
  maxRPM: 1100,
  enabled: true,
}

export function useRosActuatorLoop(
  physicsWorld: DronePhysicsWorld | null,
  config: ActuatorLoopConfig = {}
): UseRosActuatorLoopReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }

  const isRunningRef = useRef(false)
  const commandsSentRef = useRef(0)
  const lastErrorRef = useRef<string | null>(null)
  const configRef = useRef(mergedConfig)
  configRef.current = mergedConfig

  // The publish loop runs at up to rateHz and mutates the refs above; mutating a
  // ref does not re-render, so consumers would see frozen status. Publish a
  // reactive snapshot of the refs to state at a low fixed cadence instead of
  // re-rendering every tick.
  const [status, setStatus] = useState<UseRosActuatorLoopReturn>({
    isRunning: false,
    commandsSent: 0,
    lastError: null,
  })

  useEffect(() => {
    if (!physicsWorld || !mergedConfig.enabled) {
      isRunningRef.current = false
      return
    }

    const intervalMs = 1000 / mergedConfig.rateHz
    let isProcessing = false

    const publishActuatorCommands = () => {
      if (isProcessing) return

      const bridge = getROSBridge()
      if (!bridge || !bridge.isConnected()) {
        return
      }

      isProcessing = true
      isRunningRef.current = true

      try {
        const drones = physicsWorld.getAllDrones()
        const cfg = configRef.current

        for (const drone of drones) {
          const cmds = drone.targetCommands
          const maxRPM = cfg.maxRPM

          try {
            bridge.publish(`${drone.id}/cmd/motor_speed/0`, { data: cmds.front_right * maxRPM })
            bridge.publish(`${drone.id}/cmd/motor_speed/1`, { data: cmds.front_left * maxRPM })
            bridge.publish(`${drone.id}/cmd/motor_speed/2`, { data: cmds.rear_left * maxRPM })
            bridge.publish(`${drone.id}/cmd/motor_speed/3`, { data: cmds.rear_right * maxRPM })
            commandsSentRef.current += 4
          } catch (err) {
            lastErrorRef.current = err instanceof Error ? err.message : String(err)
          }
        }
      } catch (err) {
        lastErrorRef.current = err instanceof Error ? err.message : String(err)
      } finally {
        isProcessing = false
      }
    }

    const intervalId = setInterval(publishActuatorCommands, intervalMs)

    return () => {
      clearInterval(intervalId)
      isRunningRef.current = false
    }
  }, [physicsWorld, mergedConfig.enabled, mergedConfig.rateHz])

  // Mirror the high-frequency ref counters into state ~4×/sec so consumers see
  // live status without re-rendering on every actuator tick.
  useEffect(() => {
    const snapshotId = setInterval(() => {
      setStatus((prev) =>
        prev.isRunning === isRunningRef.current &&
        prev.commandsSent === commandsSentRef.current &&
        prev.lastError === lastErrorRef.current
          ? prev
          : {
              isRunning: isRunningRef.current,
              commandsSent: commandsSentRef.current,
              lastError: lastErrorRef.current,
            }
      )
    }, 250)
    return () => clearInterval(snapshotId)
  }, [])

  return status
}

export default useRosActuatorLoop
