/**
 * CREBAIN Drone Physics Engine
 * Quadcopter physics using Rapier.js
 *
 * Features:
 * - Simplified aerodynamics (thrust, drag, torque)
 * - Fixed-step physics at 120Hz
 * - Local simulation path without ROS/Gazebo middleware in the update loop
 * - Compatible with Three.js and Gaussian Splat rendering
 */

import * as THREE from 'three'
import type * as RapierNamespace from '@dimforge/rapier3d-compat'

type RapierModule = typeof RapierNamespace
type World = InstanceType<RapierModule['World']>
type RigidBody = InstanceType<RapierModule['RigidBody']>
type Collider = InstanceType<RapierModule['Collider']>

export interface QuadcopterParams {
  mass: number // kg
  armLength: number // m (distance from center to rotor)
  rotorRadius: number // m
  maxThrust: number // N (per rotor)
  maxTorque: number // Nm
  dragCoefficient: number // Cd
  crossSectionArea: number // m² (frontal area)
  momentOfInertia: THREE.Vector3 // kg·m²
  thrustCoefficient: number // k_t: thrust = k_t * ω²
  torqueCoefficient: number // k_τ: torque = k_τ * ω²
}

export const DEFAULT_QUADCOPTER_PARAMS: QuadcopterParams = {
  mass: 1.5, // 1.5 kg typical small drone
  armLength: 0.25, // 250mm arm
  rotorRadius: 0.127, // 5" propeller
  maxThrust: 15, // ~15N per rotor
  maxTorque: 0.5, // 0.5 Nm
  dragCoefficient: 1.0, // Typical for quadcopter
  crossSectionArea: 0.04, // ~40cm² frontal area
  momentOfInertia: new THREE.Vector3(0.01, 0.02, 0.01),
  thrustCoefficient: 1.91e-6, // Typical for 5" props
  torqueCoefficient: 2.6e-7, // Counter-torque coefficient
}

export interface RotorState {
  rpm: number
  thrust: number // N
  torque: number // Nm
  position: THREE.Vector3 // Relative to drone center
  direction: 1 | -1 // CW or CCW
}

export interface DroneState {
  position: THREE.Vector3
  velocity: THREE.Vector3
  acceleration: THREE.Vector3
  orientation: THREE.Quaternion
  angularVelocity: THREE.Vector3
  rotors: RotorState[]
  battery: number // 0-1
  armed: boolean
}

export interface MotorCommands {
  front_left: number
  front_right: number
  rear_left: number
  rear_right: number
}

/** T = k_t * ω² (ω in rad/s) */
function calculateThrust(rpm: number, k_t: number): number {
  const omega = (rpm * 2 * Math.PI) / 60
  return k_t * omega * omega
}

/** τ = k_τ * ω² */
function calculateTorque(rpm: number, k_τ: number): number {
  const omega = (rpm * 2 * Math.PI) / 60
  return k_τ * omega * omega
}

/** F_drag = 0.5 * ρ * v² * C_d * A */
function calculateDrag(
  velocity: THREE.Vector3,
  Cd: number,
  A: number,
  airDensity: number = 1.225
): THREE.Vector3 {
  const speed = velocity.length()
  if (speed < 0.001) return new THREE.Vector3()

  const dragMagnitude = 0.5 * airDensity * speed * speed * Cd * A
  return velocity.clone().normalize().multiplyScalar(-dragMagnitude)
}

export class DronePhysicsBody {
  public id: string
  public params: QuadcopterParams
  public state: DroneState
  public rigidBody: RigidBody | null = null
  public collider: Collider | null = null
  public mesh: THREE.Object3D | null = null

  private _targetCommands: MotorCommands = {
    front_left: 0,
    front_right: 0,
    rear_left: 0,
    rear_right: 0,
  }

  get targetCommands(): MotorCommands {
    return this._targetCommands
  }

  constructor(
    id: string,
    params: QuadcopterParams = DEFAULT_QUADCOPTER_PARAMS,
    initialPosition: THREE.Vector3 = new THREE.Vector3(0, 10, 0)
  ) {
    this.id = id
    this.params = params

    const arm = params.armLength
    const rotorPositions = [
      new THREE.Vector3(arm, 0, arm),
      new THREE.Vector3(arm, 0, -arm),
      new THREE.Vector3(-arm, 0, -arm),
      new THREE.Vector3(-arm, 0, arm),
    ]

    this.state = {
      position: initialPosition.clone(),
      velocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      orientation: new THREE.Quaternion(),
      angularVelocity: new THREE.Vector3(),
      rotors: rotorPositions.map((pos, i) => ({
        rpm: 0,
        thrust: 0,
        torque: 0,
        position: pos,
        direction: i % 2 === 0 ? 1 : -1,
      })),
      battery: 1.0,
      armed: false,
    }
  }

  setMotorCommands(commands: MotorCommands) {
    this._targetCommands = commands
  }

  setArmed(armed: boolean) {
    this.state.armed = armed
    if (!armed) {
      this._targetCommands = { front_left: 0, front_right: 0, rear_left: 0, rear_right: 0 }
    }
  }

  updatePhysics(dt: number, gravity: THREE.Vector3 = new THREE.Vector3(0, -9.81, 0)) {
    if (!this.state.armed) {
      this.state.rotors.forEach((r) => {
        r.rpm = 0
        r.thrust = 0
        r.torque = 0
      })
      return
    }

    const { params, state } = this

    const maxRPM = 15000
    const motorResponseRate = 10
    const commands = [
      this._targetCommands.front_left,
      this._targetCommands.front_right,
      this._targetCommands.rear_left,
      this._targetCommands.rear_right,
    ]

    const totalThrust = new THREE.Vector3()
    const totalTorque = new THREE.Vector3()

    // Scratch vectors reused across rotors to avoid per-rotor allocations in the
    // 120Hz update loop.
    const thrustDir = new THREE.Vector3()
    const leverArm = new THREE.Vector3()
    const rotorTorque = new THREE.Vector3()
    const thrustScaled = new THREE.Vector3()

    state.rotors.forEach((rotor, i) => {
      const targetRPM = commands[i] * maxRPM
      rotor.rpm += (targetRPM - rotor.rpm) * motorResponseRate * dt
      rotor.rpm = Math.max(0, Math.min(maxRPM, rotor.rpm))

      rotor.thrust = calculateThrust(rotor.rpm, params.thrustCoefficient)
      rotor.torque = calculateTorque(rotor.rpm, params.torqueCoefficient)

      rotor.thrust = Math.min(rotor.thrust, params.maxThrust)
      rotor.torque = Math.min(rotor.torque, params.maxTorque)

      thrustDir.set(0, 1, 0).applyQuaternion(state.orientation)
      thrustScaled.copy(thrustDir).multiplyScalar(rotor.thrust)
      totalThrust.add(thrustScaled)

      totalTorque.y += rotor.torque * rotor.direction

      leverArm.copy(rotor.position).applyQuaternion(state.orientation)
      rotorTorque.crossVectors(leverArm, thrustScaled.multiplyScalar(rotor.thrust))
      totalTorque.add(rotorTorque)
    })

    const drag = calculateDrag(state.velocity, params.dragCoefficient, params.crossSectionArea)

    const gravityForce = gravity.clone().multiplyScalar(params.mass)
    const totalForce = totalThrust.add(drag).add(gravityForce)

    state.acceleration = totalForce.divideScalar(params.mass)

    state.velocity.add(state.acceleration.clone().multiplyScalar(dt))
    state.position.add(state.velocity.clone().multiplyScalar(dt))

    const angularAccel = new THREE.Vector3(
      totalTorque.x / params.momentOfInertia.x,
      totalTorque.y / params.momentOfInertia.y,
      totalTorque.z / params.momentOfInertia.z
    )

    state.angularVelocity.add(angularAccel.multiplyScalar(dt))
    state.angularVelocity.multiplyScalar(0.98)

    // dq/dt = 0.5 * omega_quat * q
    const omegaQuat = new THREE.Quaternion(
      state.angularVelocity.x,
      state.angularVelocity.y,
      state.angularVelocity.z,
      0
    )
    const qDot = new THREE.Quaternion()
    qDot.multiplyQuaternions(omegaQuat, state.orientation)
    qDot.x *= 0.5 * dt
    qDot.y *= 0.5 * dt
    qDot.z *= 0.5 * dt
    qDot.w *= 0.5 * dt

    state.orientation.x += qDot.x
    state.orientation.y += qDot.y
    state.orientation.z += qDot.z
    state.orientation.w += qDot.w
    state.orientation.normalize()

    if (state.position.y < 0.1) {
      state.position.y = 0.1
      state.velocity.y = Math.max(0, state.velocity.y)
    }

    const powerDraw = state.rotors.reduce((sum, r) => sum + r.rpm / maxRPM, 0) / 4
    state.battery -= powerDraw * 0.0001 * dt
    state.battery = Math.max(0, state.battery)
  }

  syncMesh() {
    if (this.mesh) {
      this.mesh.position.copy(this.state.position)
      this.mesh.quaternion.copy(this.state.orientation)
    }
  }
}

/**
 * Module-level shared Rapier loader. Rapier's WASM `init()` is a global,
 * one-time operation; invoking it concurrently (e.g. React StrictMode
 * double-invoking the physics init effect, which constructs two
 * DronePhysicsWorld instances whose init() both race the global wasm init)
 * corrupts the WASM runtime ("recursive use of an object" / "memory access
 * out of bounds"). Caching the import+init promise guarantees the global
 * init runs exactly once regardless of how many worlds are created.
 */
let rapierModulePromise: Promise<RapierModule> | null = null
async function loadRapier(): Promise<RapierModule> {
  if (!rapierModulePromise) {
    rapierModulePromise = import('@dimforge/rapier3d-compat')
      .then(async (mod) => {
        await mod.init()
        return mod
      })
      .catch((err) => {
        // Allow a retry on a subsequent call if the load/init failed.
        rapierModulePromise = null
        throw err
      })
  }
  return rapierModulePromise
}

export class DronePhysicsWorld {
  private RAPIER: RapierModule | null = null
  private world: World | null = null
  private drones: Map<string, DronePhysicsBody> = new Map()
  private lastUpdate: number = 0
  private physicsHz: number = 120 // Physics update rate
  private accumulator: number = 0
  private isInitialized: boolean = false

  async init(): Promise<void> {
    try {
      this.RAPIER = await loadRapier()

      this.world = new this.RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 })

      const groundDesc = this.RAPIER.RigidBodyDesc.fixed()
      const groundBody = this.world.createRigidBody(groundDesc)
      const groundCollider = this.RAPIER.ColliderDesc.cuboid(1000.0, 0.1, 1000.0).setTranslation(
        0.0,
        -0.1,
        0.0
      )
      this.world.createCollider(groundCollider, groundBody)

      this.isInitialized = true
      this.lastUpdate = performance.now()
    } catch {
      this.isInitialized = true
    }
  }

  isReady(): boolean {
    return this.isInitialized
  }

  createDrone(
    id: string,
    params?: QuadcopterParams,
    position?: THREE.Vector3,
    mesh?: THREE.Object3D
  ): DronePhysicsBody {
    const drone = new DronePhysicsBody(id, params, position)
    drone.mesh = mesh || null

    if (this.RAPIER && this.world) {
      const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(drone.state.position.x, drone.state.position.y, drone.state.position.z)
        .setLinearDamping(0.1)
        .setAngularDamping(0.5)

      drone.rigidBody = this.world.createRigidBody(bodyDesc)

      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(0.2, 0.05, 0.2).setMass(
        params?.mass || DEFAULT_QUADCOPTER_PARAMS.mass
      )

      drone.collider = this.world.createCollider(colliderDesc, drone.rigidBody)
    }

    this.drones.set(id, drone)
    return drone
  }

  removeDrone(id: string) {
    const drone = this.drones.get(id)
    if (drone) {
      if (this.world && drone.rigidBody) {
        this.world.removeRigidBody(drone.rigidBody)
      }
      this.drones.delete(id)
    }
  }

  getDrone(id: string): DronePhysicsBody | undefined {
    return this.drones.get(id)
  }

  getAllDrones(): DronePhysicsBody[] {
    return Array.from(this.drones.values())
  }

  resetTime() {
    this.lastUpdate = performance.now()
    this.accumulator = 0
  }

  update(): void {
    if (!this.isInitialized) return

    const now = performance.now()
    let deltaTime = (now - this.lastUpdate) / 1000
    this.lastUpdate = now

    if (deltaTime > 0.1) deltaTime = 0.1

    const fixedDt = 1 / this.physicsHz
    this.accumulator += deltaTime

    while (this.accumulator >= fixedDt) {
      if (this.world) {
        this.world.step()
      }

      for (const drone of this.drones.values()) {
        if (this.world && drone.rigidBody) {
          this.applyDroneForces(drone, fixedDt)

          const pos = drone.rigidBody.translation()
          const rot = drone.rigidBody.rotation()
          const vel = drone.rigidBody.linvel()
          const angVel = drone.rigidBody.angvel()

          drone.state.position.set(pos.x, pos.y, pos.z)
          drone.state.orientation.set(rot.x, rot.y, rot.z, rot.w)
          drone.state.velocity.set(vel.x, vel.y, vel.z)
          drone.state.angularVelocity.set(angVel.x, angVel.y, angVel.z)
        } else {
          drone.updatePhysics(fixedDt)
        }

        drone.syncMesh()
      }

      this.accumulator -= fixedDt
    }
  }

  private applyDroneForces(drone: DronePhysicsBody, dt: number) {
    if (!this.RAPIER || !drone.rigidBody || !drone.state.armed) return

    const { params, state } = drone
    const maxRPM = 15000

    const totalThrust = new THREE.Vector3()
    const totalTorque = new THREE.Vector3()

    // Scratch vectors + hoisted command array reused across rotors to avoid
    // per-rotor allocations in the 120Hz step loop.
    const thrustDir = new THREE.Vector3()
    const leverArm = new THREE.Vector3()
    const rotorTorque = new THREE.Vector3()
    const thrustScaled = new THREE.Vector3()
    const commands = [
      drone.targetCommands.front_left,
      drone.targetCommands.front_right,
      drone.targetCommands.rear_left,
      drone.targetCommands.rear_right,
    ]

    state.rotors.forEach((rotor, i) => {
      const targetRPM = commands[i] * maxRPM
      rotor.rpm += (targetRPM - rotor.rpm) * 10 * dt
      rotor.rpm = Math.max(0, Math.min(maxRPM, rotor.rpm))

      rotor.thrust = calculateThrust(rotor.rpm, params.thrustCoefficient)
      rotor.thrust = Math.min(rotor.thrust, params.maxThrust)

      thrustDir.set(0, 1, 0).applyQuaternion(state.orientation)
      thrustScaled.copy(thrustDir).multiplyScalar(rotor.thrust)
      totalThrust.add(thrustScaled)

      rotor.torque = calculateTorque(rotor.rpm, params.torqueCoefficient)
      totalTorque.y += rotor.torque * rotor.direction

      leverArm.copy(rotor.position).applyQuaternion(state.orientation)
      rotorTorque.crossVectors(leverArm, thrustScaled.multiplyScalar(rotor.thrust))
      totalTorque.add(rotorTorque)
    })

    drone.rigidBody.addForce({ x: totalThrust.x, y: totalThrust.y, z: totalThrust.z }, true)
    drone.rigidBody.addTorque({ x: totalTorque.x, y: totalTorque.y, z: totalTorque.z }, true)
  }

  destroy() {
    for (const id of this.drones.keys()) {
      this.removeDrone(id)
    }
    // Free the Rapier World's WASM allocation. Dropping the JS reference alone
    // leaks the underlying linear-memory backing store. World.free() also frees
    // all attached bodies/colliders, so no per-object free is needed.
    this.world?.free()
    this.world = null
    this.RAPIER = null
    this.isInitialized = false
  }
}

interface PIDGains {
  kp: number
  ki: number
  kd: number
}

interface FlightControllerConfig {
  rollPID: PIDGains
  pitchPID: PIDGains
  yawPID: PIDGains
  altitudePID: PIDGains
  maxAngle: number // radians
}

export const DEFAULT_FLIGHT_CONTROLLER_CONFIG: FlightControllerConfig = {
  rollPID: { kp: 4.0, ki: 0.5, kd: 0.8 },
  pitchPID: { kp: 4.0, ki: 0.5, kd: 0.8 },
  yawPID: { kp: 2.0, ki: 0.1, kd: 0.4 },
  altitudePID: { kp: 2.0, ki: 0.3, kd: 1.0 },
  maxAngle: Math.PI / 6,
}

export class FlightController {
  private config: FlightControllerConfig
  private rollIntegral: number = 0
  private pitchIntegral: number = 0
  private yawIntegral: number = 0
  private altitudeIntegral: number = 0
  private lastRollError: number = 0
  private lastPitchError: number = 0
  private lastYawError: number = 0
  private lastAltitudeError: number = 0

  constructor(config: FlightControllerConfig = DEFAULT_FLIGHT_CONTROLLER_CONFIG) {
    this.config = config
  }

  update(
    drone: DronePhysicsBody,
    targetRoll: number,
    targetPitch: number,
    targetYawRate: number,
    targetAltitude: number,
    dt: number
  ): MotorCommands {
    const { state } = drone

    const euler = new THREE.Euler().setFromQuaternion(state.orientation, 'YXZ')
    const currentRoll = euler.z
    const currentPitch = euler.x

    targetRoll = Math.max(-this.config.maxAngle, Math.min(this.config.maxAngle, targetRoll))
    targetPitch = Math.max(-this.config.maxAngle, Math.min(this.config.maxAngle, targetPitch))

    const rollError = targetRoll - currentRoll
    this.rollIntegral += rollError * dt
    const rollDerivative = (rollError - this.lastRollError) / dt
    const rollOutput =
      this.config.rollPID.kp * rollError +
      this.config.rollPID.ki * this.rollIntegral +
      this.config.rollPID.kd * rollDerivative
    this.lastRollError = rollError

    const pitchError = targetPitch - currentPitch
    this.pitchIntegral += pitchError * dt
    const pitchDerivative = (pitchError - this.lastPitchError) / dt
    const pitchOutput =
      this.config.pitchPID.kp * pitchError +
      this.config.pitchPID.ki * this.pitchIntegral +
      this.config.pitchPID.kd * pitchDerivative
    this.lastPitchError = pitchError

    const yawRateError = targetYawRate - state.angularVelocity.y
    this.yawIntegral += yawRateError * dt
    const yawDerivative = (yawRateError - this.lastYawError) / dt
    const yawOutput =
      this.config.yawPID.kp * yawRateError +
      this.config.yawPID.ki * this.yawIntegral +
      this.config.yawPID.kd * yawDerivative
    this.lastYawError = yawRateError

    const altitudeError = targetAltitude - state.position.y
    this.altitudeIntegral += altitudeError * dt
    this.altitudeIntegral = Math.max(-10, Math.min(10, this.altitudeIntegral))
    const altitudeDerivative = (altitudeError - this.lastAltitudeError) / dt
    const altitudeOutput =
      this.config.altitudePID.kp * altitudeError +
      this.config.altitudePID.ki * this.altitudeIntegral +
      this.config.altitudePID.kd * altitudeDerivative
    this.lastAltitudeError = altitudeError

    const baseThrottle = 0.5 + altitudeOutput * 0.1

    const commands: MotorCommands = {
      front_left: this.clamp(baseThrottle + pitchOutput + rollOutput - yawOutput),
      front_right: this.clamp(baseThrottle + pitchOutput - rollOutput + yawOutput),
      rear_left: this.clamp(baseThrottle - pitchOutput + rollOutput + yawOutput),
      rear_right: this.clamp(baseThrottle - pitchOutput - rollOutput - yawOutput),
    }

    return commands
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(1, value))
  }

  reset() {
    this.rollIntegral = 0
    this.pitchIntegral = 0
    this.yawIntegral = 0
    this.altitudeIntegral = 0
    this.lastRollError = 0
    this.lastPitchError = 0
    this.lastYawError = 0
    this.lastAltitudeError = 0
  }
}

export default DronePhysicsWorld
