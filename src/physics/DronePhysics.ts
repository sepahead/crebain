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
import { logger } from '../lib/logger'
import { staticGeometryData, type StaticCuboid, type StaticGeometryHandle } from './StaticGeometry'

const log = logger.scope('Physics')

/** Fixed simulation step: 120 Hz. Shared by Rapier and the local fallback. */
export const PHYSICS_FIXED_DT = 1 / 120
export const MAX_PHYSICS_DT_SECONDS = 0.1
const MAX_ROTOR_RPM = 15_000
const BATTERY_DRAIN_RATE_PER_SECOND = 0.0001

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

const ZERO_MOTOR_COMMANDS: Readonly<MotorCommands> = Object.freeze({
  front_left: 0,
  front_right: 0,
  rear_left: 0,
  rear_right: 0,
})

function clampMotorCommand(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isFiniteVector3(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}

function validateQuadcopterParams(params: QuadcopterParams): void {
  for (const [name, value] of [
    ['mass', params.mass],
    ['armLength', params.armLength],
    ['rotorRadius', params.rotorRadius],
    ['maxThrust', params.maxThrust],
    ['maxTorque', params.maxTorque],
    ['crossSectionArea', params.crossSectionArea],
    ['thrustCoefficient', params.thrustCoefficient],
    ['torqueCoefficient', params.torqueCoefficient],
  ] as const) {
    assertPositiveFinite(value, `Quadcopter ${name}`)
  }
  if (!Number.isFinite(params.dragCoefficient) || params.dragCoefficient < 0) {
    throw new Error('Quadcopter dragCoefficient must be a non-negative finite number')
  }
  if (!isFiniteVector3(params.momentOfInertia)) {
    throw new Error('Quadcopter momentOfInertia must contain finite values')
  }
  assertPositiveFinite(params.momentOfInertia.x, 'Quadcopter momentOfInertia.x')
  assertPositiveFinite(params.momentOfInertia.y, 'Quadcopter momentOfInertia.y')
  assertPositiveFinite(params.momentOfInertia.z, 'Quadcopter momentOfInertia.z')
}

function assertValidPhysicsStep(dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0 || dt > MAX_PHYSICS_DT_SECONDS) {
    throw new Error(`Physics dt must be finite and in (0, ${MAX_PHYSICS_DT_SECONDS}] seconds`)
  }
}

/**
 * Canonical mixer for the local +Z-forward, +X-right rotor geometry:
 * FL (-x,+z), FR (+x,+z), RL (-x,-z), RR (+x,-z), with +Y thrust.
 * The vehicle faces local +Z, so local +X is right. Positive logical roll is
 * a right bank and therefore requests -Z torque; positive pitch and yaw
 * request +X and +Y torque.
 */
export function mixQuadMotorCommands(
  baseThrottle: number,
  roll: number,
  pitch: number,
  yaw: number
): MotorCommands {
  return {
    front_left: clampMotorCommand(baseThrottle + roll - pitch - yaw),
    front_right: clampMotorCommand(baseThrottle - roll - pitch + yaw),
    rear_left: clampMotorCommand(baseThrottle + roll + pitch + yaw),
    rear_right: clampMotorCommand(baseThrottle - roll + pitch - yaw),
  }
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

function advanceBattery(state: DroneState, dt: number): void {
  if (state.rotors.length === 0) return
  const normalizedPower =
    state.rotors.reduce((sum, rotor) => sum + rotor.rpm / MAX_ROTOR_RPM, 0) / state.rotors.length
  state.battery = Math.max(0, state.battery - normalizedPower * BATTERY_DRAIN_RATE_PER_SECOND * dt)
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

/**
 * Convert a world-space torque into world-space angular acceleration while
 * applying the configured principal moments in the drone body frame.
 *
 * `DroneState.angularVelocity` is world-space (matching Rapier's `angvel()` and
 * the left-multiplied quaternion derivative below), so both angular velocity
 * and torque are rotated into the body frame for Euler's rigid-body equation:
 * I * omegaDot + omega x (I * omega) = torque.
 */
function calculateWorldAngularAcceleration(
  torqueWorld: THREE.Vector3,
  angularVelocityWorld: THREE.Vector3,
  orientation: THREE.Quaternion,
  principalInertia: THREE.Vector3
): THREE.Vector3 {
  const inverseOrientation = orientation.clone().invert()
  const angularVelocityBody = angularVelocityWorld.clone().applyQuaternion(inverseOrientation)
  const torqueBody = torqueWorld.clone().applyQuaternion(inverseOrientation)
  const angularMomentumBody = new THREE.Vector3(
    principalInertia.x * angularVelocityBody.x,
    principalInertia.y * angularVelocityBody.y,
    principalInertia.z * angularVelocityBody.z
  )
  const gyroscopicTorqueBody = new THREE.Vector3().crossVectors(
    angularVelocityBody,
    angularMomentumBody
  )
  const netTorqueBody = torqueBody.sub(gyroscopicTorqueBody)

  return new THREE.Vector3(
    netTorqueBody.x / principalInertia.x,
    netTorqueBody.y / principalInertia.y,
    netTorqueBody.z / principalInertia.z
  ).applyQuaternion(orientation)
}

export class DronePhysicsBody {
  public id: string
  public params: QuadcopterParams
  public state: DroneState
  public rigidBody: RigidBody | null = null
  public collider: Collider | null = null
  public mesh: THREE.Object3D | null = null

  private _targetCommands: Readonly<MotorCommands> = ZERO_MOTOR_COMMANDS

  get targetCommands(): Readonly<MotorCommands> {
    return this._targetCommands
  }

  constructor(
    id: string,
    params: QuadcopterParams = DEFAULT_QUADCOPTER_PARAMS,
    initialPosition: THREE.Vector3 = new THREE.Vector3(0, 10, 0)
  ) {
    this.id = id
    validateQuadcopterParams(params)
    if (!isFiniteVector3(initialPosition)) {
      throw new Error('Initial drone position must contain finite values')
    }
    this.params = {
      ...params,
      momentOfInertia: params.momentOfInertia.clone(),
    }

    const arm = this.params.armLength
    const rotorLayout = [
      { position: new THREE.Vector3(-arm, 0, arm), direction: -1 as const },
      { position: new THREE.Vector3(arm, 0, arm), direction: 1 as const },
      { position: new THREE.Vector3(-arm, 0, -arm), direction: 1 as const },
      { position: new THREE.Vector3(arm, 0, -arm), direction: -1 as const },
    ]

    this.state = {
      position: initialPosition.clone(),
      velocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      orientation: new THREE.Quaternion(),
      angularVelocity: new THREE.Vector3(),
      rotors: rotorLayout.map(({ position, direction }) => ({
        rpm: 0,
        thrust: 0,
        torque: 0,
        position,
        direction,
      })),
      battery: 1.0,
      armed: false,
    }
  }

  setMotorCommands(commands: MotorCommands) {
    this._targetCommands = Object.freeze({
      front_left: clampMotorCommand(commands.front_left),
      front_right: clampMotorCommand(commands.front_right),
      rear_left: clampMotorCommand(commands.rear_left),
      rear_right: clampMotorCommand(commands.rear_right),
    })
  }

  setArmed(armed: boolean) {
    this.state.armed = armed
    if (!armed) {
      this._targetCommands = ZERO_MOTOR_COMMANDS
    }
  }

  updatePhysics(dt: number, gravity: THREE.Vector3 = new THREE.Vector3(0, -9.81, 0)) {
    assertValidPhysicsStep(dt)
    if (!isFiniteVector3(gravity)) {
      throw new Error('Physics gravity must contain finite values')
    }
    const { params, state } = this

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
    const reactionTorque = new THREE.Vector3()
    const thrustScaled = new THREE.Vector3()

    if (!state.armed) {
      // Disarmed: rotors produce no thrust or torque, but gravity/drag
      // integration below must still run so the drone falls instead of hanging
      // mid-air (keeps the local path consistent with the Rapier path, where
      // gravity always applies).
      state.rotors.forEach((r) => {
        r.rpm = 0
        r.thrust = 0
        r.torque = 0
      })
    } else {
      state.rotors.forEach((rotor, i) => {
        const targetRPM = commands[i] * MAX_ROTOR_RPM
        rotor.rpm += (targetRPM - rotor.rpm) * motorResponseRate * dt
        rotor.rpm = Math.max(0, Math.min(MAX_ROTOR_RPM, rotor.rpm))

        rotor.thrust = calculateThrust(rotor.rpm, params.thrustCoefficient)
        rotor.torque = calculateTorque(rotor.rpm, params.torqueCoefficient)

        rotor.thrust = Math.min(rotor.thrust, params.maxThrust)
        rotor.torque = Math.min(rotor.torque, params.maxTorque)

        thrustDir.set(0, 1, 0).applyQuaternion(state.orientation)
        thrustScaled.copy(thrustDir).multiplyScalar(rotor.thrust)
        totalThrust.add(thrustScaled)

        // Rotor reaction torque acts around the body thrust axis, so it must
        // rotate with the drone just like thrust and lever-arm torque.
        reactionTorque.copy(thrustDir).multiplyScalar(rotor.torque * rotor.direction)
        totalTorque.add(reactionTorque)

        // thrustScaled already includes rotor.thrust; do not scale again.
        leverArm.copy(rotor.position).applyQuaternion(state.orientation)
        rotorTorque.crossVectors(leverArm, thrustScaled)
        totalTorque.add(rotorTorque)
      })
    }

    const drag = calculateDrag(state.velocity, params.dragCoefficient, params.crossSectionArea)

    const gravityForce = gravity.clone().multiplyScalar(params.mass)
    const totalForce = totalThrust.add(drag).add(gravityForce)

    state.acceleration = totalForce.divideScalar(params.mass)

    state.velocity.add(state.acceleration.clone().multiplyScalar(dt))
    state.position.add(state.velocity.clone().multiplyScalar(dt))

    const angularAccel = calculateWorldAngularAcceleration(
      totalTorque,
      state.angularVelocity,
      state.orientation,
      params.momentOfInertia
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

    advanceBattery(state, dt)
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

export interface FlightControllerCheckpoint {
  config: FlightControllerConfig
  integrals: [number, number, number, number]
  previousErrors: [number, number, number, number]
}

export const MAX_PHYSICS_CHECKPOINT_BYTES = 4 * 1024 * 1024

/** Complete serialized Rapier and JavaScript dynamics state for exact comparison. */
export interface PhysicsCheckpoint {
  readonly serialized: string
}

interface PhysicsCheckpointState {
  runtime: string
  rapier: number[]
  staticGeometry?: StaticCuboid[]
  drones: Array<{
    id: string
    params: Omit<QuadcopterParams, 'momentOfInertia'> & { momentOfInertia: number[] }
    position: number[]
    velocity: number[]
    acceleration: number[]
    orientation: number[]
    angularVelocity: number[]
    rotors: Array<Omit<RotorState, 'position'> & { position: number[] }>
    battery: number
    armed: boolean
    commands: MotorCommands
    bodyHandle: number
    colliderHandle: number
  }>
}

export class DronePhysicsWorld {
  private RAPIER: RapierModule | null = null
  private world: World | null = null
  private drones: Map<string, DronePhysicsBody> = new Map()
  private lastUpdate: number = 0
  private accumulator: number = 0
  private isInitialized: boolean = false
  private usingFallback: boolean = false
  private initializationPromise: Promise<void> | null = null
  private lifecycleGeneration = 0

  private readonly staticGeometry: StaticCuboid[]

  constructor(
    private readonly clock: 'wall' | 'explicit' = 'wall',
    staticGeometry?: StaticGeometryHandle
  ) {
    this.staticGeometry = staticGeometry === undefined ? [] : staticGeometryData(staticGeometry)
    if (clock !== 'explicit' && this.staticGeometry.length > 0)
      throw new Error('Static scenario geometry requires explicit physics ownership')
  }

  init(): Promise<void> {
    if (this.isInitialized) return Promise.resolve()
    if (this.initializationPromise) return this.initializationPromise

    const generation = this.lifecycleGeneration
    const trackedInitialization = this.initialize(generation).finally(() => {
      if (this.initializationPromise === trackedInitialization) {
        this.initializationPromise = null
      }
    })
    this.initializationPromise = trackedInitialization
    return trackedInitialization
  }

  private async initialize(generation: number): Promise<void> {
    let candidateWorld: World | null = null
    try {
      const rapier = await loadRapier()
      if (this.lifecycleGeneration !== generation) return

      candidateWorld = new rapier.World({ x: 0.0, y: -9.81, z: 0.0 })
      candidateWorld.timestep = PHYSICS_FIXED_DT

      const groundDesc = rapier.RigidBodyDesc.fixed()
      const groundBody = candidateWorld.createRigidBody(groundDesc)
      const groundCollider = rapier.ColliderDesc.cuboid(1000.0, 0.1, 1000.0).setTranslation(
        0.0,
        -0.1,
        0.0
      )
      candidateWorld.createCollider(groundCollider, groundBody)

      for (const shape of this.staticGeometry) {
        const rotation = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          shape.yaw
        )
        const body = candidateWorld.createRigidBody(
          rapier.RigidBodyDesc.fixed()
            .setTranslation(...shape.center)
            .setRotation(rotation)
        )
        candidateWorld.createCollider(
          rapier.ColliderDesc.cuboid(...shape.halfExtents)
            .setFriction(shape.friction)
            .setRestitution(shape.restitution),
          body
        )
      }

      if (this.lifecycleGeneration !== generation) {
        candidateWorld.free()
        candidateWorld = null
        return
      }

      // Publish the Rapier pair only after the complete world is usable. A
      // failed ground allocation must not leave a half-initialized world on the
      // object while the public state reports that the local fallback is active.
      this.RAPIER = rapier
      this.world = candidateWorld
      candidateWorld = null
      this.isInitialized = true
      this.usingFallback = false
      this.lastUpdate = performance.now()
    } catch (error) {
      try {
        candidateWorld?.free()
      } catch (cleanupError) {
        log.error('Failed to release a partially initialized Rapier world', { cleanupError })
      }
      if (this.lifecycleGeneration !== generation) return
      this.world = null
      this.RAPIER = null
      // Rapier failed to load/init (e.g. WASM unavailable). Fall back to the
      // local integrator path (DronePhysicsBody.updatePhysics) and say so
      // loudly instead of silently swallowing the failure.
      log.error('Rapier physics init failed; falling back to local integrator', { error })
      this.usingFallback = true
      this.isInitialized = true
      this.lastUpdate = performance.now()
    }
  }

  isReady(): boolean {
    return this.isInitialized
  }

  /** True when Rapier failed to initialize and the local integrator is used. */
  isUsingFallback(): boolean {
    return this.usingFallback
  }

  createDrone(
    id: string,
    params?: QuadcopterParams,
    position?: THREE.Vector3,
    mesh?: THREE.Object3D
  ): DronePhysicsBody {
    // A drone must enter exactly one physics implementation for its complete
    // lifetime. Creating it while Rapier is still loading would register a
    // local-integrator body that cannot be migrated safely after init().
    if (!this.isInitialized) {
      throw new Error('Drone physics world must be initialized before creating drones')
    }

    // Reject before constructing a replacement or allocating Rapier resources.
    // Overwriting the Map entry would strand the old body in the physics world,
    // where it would remain simulated and collidable but no longer removable.
    if (this.drones.has(id)) {
      throw new Error(`Drone with id "${id}" already exists`)
    }

    const drone = new DronePhysicsBody(id, params, position)
    drone.mesh = mesh || null

    if (this.RAPIER && this.world) {
      let createdBody: RigidBody | null = null
      try {
        const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(drone.state.position.x, drone.state.position.y, drone.state.position.z)
          .setLinearDamping(0.1)
          .setAngularDamping(0.5)

        createdBody = this.world.createRigidBody(bodyDesc)
        drone.rigidBody = createdBody

        // Use the same configured mass and body-frame principal inertia as the
        // local integrator. The cuboid remains the collision shape; its inferred
        // mass properties must not silently replace the flight-model parameters.
        const colliderDesc = this.RAPIER.ColliderDesc.cuboid(0.2, 0.05, 0.2).setMassProperties(
          drone.params.mass,
          { x: 0, y: 0, z: 0 },
          {
            x: drone.params.momentOfInertia.x,
            y: drone.params.momentOfInertia.y,
            z: drone.params.momentOfInertia.z,
          },
          { x: 0, y: 0, z: 0, w: 1 }
        )

        drone.collider = this.world.createCollider(colliderDesc, createdBody)
      } catch (error) {
        if (createdBody) {
          try {
            this.world.removeRigidBody(createdBody)
          } catch (cleanupError) {
            log.error('Failed to roll back a partially created Rapier drone', {
              id,
              cleanupError,
            })
          }
        }
        drone.rigidBody = null
        drone.collider = null
        throw error
      }
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
    if (this.clock === 'explicit') {
      throw new Error('Explicit physics worlds require advanceTicks')
    }
    if (!this.isInitialized) return

    const now = performance.now()
    if (!Number.isFinite(now)) return
    let deltaTime = (now - this.lastUpdate) / 1000
    if (!Number.isFinite(deltaTime) || deltaTime < 0) return
    this.lastUpdate = now
    if (deltaTime > MAX_PHYSICS_DT_SECONDS) deltaTime = MAX_PHYSICS_DT_SECONDS

    this.accumulator += deltaTime

    while (this.accumulator >= PHYSICS_FIXED_DT) {
      this.stepFixedTick()
      this.accumulator -= PHYSICS_FIXED_DT
    }
  }

  /** Advance the existing dynamics without consulting or changing the wall clock. */
  advanceTicks(ticks: number): void {
    if (this.clock !== 'explicit' || !this.isInitialized || !this.world) {
      throw new Error('Explicit advancement requires an initialized Rapier world')
    }
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 2400) {
      throw new Error('Physics advance must contain 1 through 2400 ticks')
    }
    for (let tick = 0; tick < ticks; tick++) this.stepFixedTick()
  }

  private stepFixedTick(): void {
    if (this.world) {
      // Rapier integrates user forces during step(), so each drone's forces
      // must be prepared first. Applying them afterward introduces a full
      // fixed-step control delay and advances the first step under gravity
      // alone.
      for (const drone of this.drones.values()) {
        if (drone.rigidBody) {
          this.applyDroneForces(drone, PHYSICS_FIXED_DT)
        }
      }
      this.world.step()
    }

    for (const drone of this.drones.values()) {
      if (this.world && drone.rigidBody) {
        const pos = drone.rigidBody.translation()
        const rot = drone.rigidBody.rotation()
        const vel = drone.rigidBody.linvel()
        const angVel = drone.rigidBody.angvel()

        drone.state.position.set(pos.x, pos.y, pos.z)
        drone.state.orientation.set(rot.x, rot.y, rot.z, rot.w)
        drone.state.velocity.set(vel.x, vel.y, vel.z)
        drone.state.angularVelocity.set(angVel.x, angVel.y, angVel.z)
      } else {
        drone.updatePhysics(PHYSICS_FIXED_DT)
      }

      drone.syncMesh()
    }
  }

  /** Capture only the admitted explicit Rapier dynamics, without presentation resources. */
  checkpoint(): PhysicsCheckpoint {
    if (this.clock !== 'explicit' || !this.world || !this.RAPIER) {
      throw new Error('Checkpoints require explicit Rapier dynamics')
    }
    const state: PhysicsCheckpointState = {
      runtime: this.RAPIER.version(),
      rapier: Array.from(this.world.takeSnapshot()),
      ...(this.staticGeometry.length > 0 ? { staticGeometry: this.staticGeometry } : {}),
      drones: this.getAllDrones().map((drone) => {
        if (!drone.rigidBody || !drone.collider) throw new Error('Incomplete Rapier drone')
        return {
          id: drone.id,
          params: { ...drone.params, momentOfInertia: drone.params.momentOfInertia.toArray() },
          position: drone.state.position.toArray(),
          velocity: drone.state.velocity.toArray(),
          acceleration: drone.state.acceleration.toArray(),
          orientation: drone.state.orientation.toArray(),
          angularVelocity: drone.state.angularVelocity.toArray(),
          rotors: drone.state.rotors.map((rotor) => ({
            ...rotor,
            position: rotor.position.toArray(),
          })),
          battery: drone.state.battery,
          armed: drone.state.armed,
          commands: { ...drone.targetCommands },
          bodyHandle: drone.rigidBody.handle,
          colliderHandle: drone.collider.handle,
        }
      }),
    }
    const serialized = JSON.stringify(state, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('Non-finite physics checkpoint state')
      }
      if (Object.is(value, -0)) return { float64: 'negative-zero' }
      return value
    })
    if (serialized.length > MAX_PHYSICS_CHECKPOINT_BYTES) {
      throw new Error('Physics checkpoint exceeds its byte budget')
    }
    const checkpoint = Object.freeze({ serialized })
    return checkpoint
  }

  private applyDroneForces(drone: DronePhysicsBody, dt: number) {
    if (!this.RAPIER || !drone.rigidBody) return

    // Rapier user forces/torques are persistent: without a reset every
    // addForce/addTorque call would accumulate across 120Hz steps unboundedly.
    // Clear the previous step's contribution so exactly one step's worth of
    // force is active at a time.
    drone.rigidBody.resetForces(true)
    drone.rigidBody.resetTorques(true)

    if (!drone.state.armed) {
      // Disarmed: no rotor forces; gravity in the Rapier world takes over.
      drone.state.rotors.forEach((r) => {
        r.rpm = 0
        r.thrust = 0
        r.torque = 0
      })
      return
    }

    const { params, state } = drone
    const totalThrust = new THREE.Vector3()
    const totalTorque = new THREE.Vector3()

    // Scratch vectors + hoisted command array reused across rotors to avoid
    // per-rotor allocations in the 120Hz step loop.
    const thrustDir = new THREE.Vector3()
    const leverArm = new THREE.Vector3()
    const rotorTorque = new THREE.Vector3()
    const reactionTorque = new THREE.Vector3()
    const thrustScaled = new THREE.Vector3()
    const commands = [
      drone.targetCommands.front_left,
      drone.targetCommands.front_right,
      drone.targetCommands.rear_left,
      drone.targetCommands.rear_right,
    ]

    state.rotors.forEach((rotor, i) => {
      const targetRPM = commands[i] * MAX_ROTOR_RPM
      rotor.rpm += (targetRPM - rotor.rpm) * 10 * dt
      rotor.rpm = Math.max(0, Math.min(MAX_ROTOR_RPM, rotor.rpm))

      rotor.thrust = calculateThrust(rotor.rpm, params.thrustCoefficient)
      rotor.thrust = Math.min(rotor.thrust, params.maxThrust)

      thrustDir.set(0, 1, 0).applyQuaternion(state.orientation)
      thrustScaled.copy(thrustDir).multiplyScalar(rotor.thrust)
      totalThrust.add(thrustScaled)

      rotor.torque = calculateTorque(rotor.rpm, params.torqueCoefficient)
      rotor.torque = Math.min(rotor.torque, params.maxTorque)
      reactionTorque.copy(thrustDir).multiplyScalar(rotor.torque * rotor.direction)
      totalTorque.add(reactionTorque)

      // thrustScaled already includes rotor.thrust; do not scale again.
      leverArm.copy(rotor.position).applyQuaternion(state.orientation)
      rotorTorque.crossVectors(leverArm, thrustScaled)
      totalTorque.add(rotorTorque)
    })

    // Keep public simulation state consistent with the local fallback. Without
    // this update, the default Rapier path reported a permanently full battery.
    advanceBattery(state, dt)

    drone.rigidBody.addForce({ x: totalThrust.x, y: totalThrust.y, z: totalThrust.z }, true)
    drone.rigidBody.addTorque({ x: totalTorque.x, y: totalTorque.y, z: totalTorque.z }, true)
  }

  destroy() {
    this.lifecycleGeneration += 1
    this.initializationPromise = null
    const cleanupErrors: unknown[] = []
    for (const id of Array.from(this.drones.keys())) {
      try {
        this.removeDrone(id)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    // Free the Rapier World's WASM allocation. Dropping the JS reference alone
    // leaks the underlying linear-memory backing store. World.free() also frees
    // all attached bodies/colliders, so no per-object free is needed.
    try {
      this.world?.free()
    } catch (error) {
      cleanupErrors.push(error)
    }
    this.drones.clear()
    this.world = null
    this.RAPIER = null
    this.isInitialized = false
    this.usingFallback = false
    this.accumulator = 0
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Drone physics world cleanup failed')
    }
  }
}

interface PIDGains {
  kp: number
  ki: number
  kd: number
}

export interface FlightControllerConfig {
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

/** Anti-windup clamp applied to every PID integral term. */
const PID_INTEGRAL_LIMIT = 10

function clampIntegral(value: number): number {
  return Math.max(-PID_INTEGRAL_LIMIT, Math.min(PID_INTEGRAL_LIMIT, value))
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
    for (const [name, gains] of [
      ['rollPID', config.rollPID],
      ['pitchPID', config.pitchPID],
      ['yawPID', config.yawPID],
      ['altitudePID', config.altitudePID],
    ] as const) {
      if (![gains.kp, gains.ki, gains.kd].every(Number.isFinite)) {
        throw new Error(`${name} gains must be finite`)
      }
    }
    assertPositiveFinite(config.maxAngle, 'Flight controller maxAngle')
    this.config = {
      rollPID: { ...config.rollPID },
      pitchPID: { ...config.pitchPID },
      yawPID: { ...config.yawPID },
      altitudePID: { ...config.altitudePID },
      maxAngle: config.maxAngle,
    }
  }

  /** Complete controller memory, including derivative history and configured gains. */
  checkpoint(): FlightControllerCheckpoint {
    return {
      config: structuredClone(this.config),
      integrals: [this.rollIntegral, this.pitchIntegral, this.yawIntegral, this.altitudeIntegral],
      previousErrors: [
        this.lastRollError,
        this.lastPitchError,
        this.lastYawError,
        this.lastAltitudeError,
      ],
    }
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

    if (!state.armed) {
      // Disarmed: clear all PID state so stale integrals/derivatives cannot
      // wind up on the ground or kick on the next arm.
      this.reset()
      return { front_left: 0, front_right: 0, rear_left: 0, rear_right: 0 }
    }

    assertValidPhysicsStep(dt)
    if (![targetRoll, targetPitch, targetYawRate, targetAltitude].every(Number.isFinite)) {
      throw new Error('Flight controller targets must be finite')
    }

    const euler = new THREE.Euler().setFromQuaternion(state.orientation, 'YXZ')
    // Three.js +Z rotation banks local +Y thrust toward -X (vehicle-left).
    // Logical positive roll means a right bank, so its attitude coordinate is
    // the negated Three.js Z Euler component.
    const currentRoll = -euler.z
    const currentPitch = euler.x

    targetRoll = Math.max(-this.config.maxAngle, Math.min(this.config.maxAngle, targetRoll))
    targetPitch = Math.max(-this.config.maxAngle, Math.min(this.config.maxAngle, targetPitch))

    const rollError = targetRoll - currentRoll
    this.rollIntegral = clampIntegral(this.rollIntegral + rollError * dt)
    const rollDerivative = (rollError - this.lastRollError) / dt
    const rollOutput =
      this.config.rollPID.kp * rollError +
      this.config.rollPID.ki * this.rollIntegral +
      this.config.rollPID.kd * rollDerivative
    this.lastRollError = rollError

    const pitchError = targetPitch - currentPitch
    this.pitchIntegral = clampIntegral(this.pitchIntegral + pitchError * dt)
    const pitchDerivative = (pitchError - this.lastPitchError) / dt
    const pitchOutput =
      this.config.pitchPID.kp * pitchError +
      this.config.pitchPID.ki * this.pitchIntegral +
      this.config.pitchPID.kd * pitchDerivative
    this.lastPitchError = pitchError

    const yawRateError = targetYawRate - state.angularVelocity.y
    this.yawIntegral = clampIntegral(this.yawIntegral + yawRateError * dt)
    const yawDerivative = (yawRateError - this.lastYawError) / dt
    const yawOutput =
      this.config.yawPID.kp * yawRateError +
      this.config.yawPID.ki * this.yawIntegral +
      this.config.yawPID.kd * yawDerivative
    this.lastYawError = yawRateError

    const altitudeError = targetAltitude - state.position.y
    this.altitudeIntegral = clampIntegral(this.altitudeIntegral + altitudeError * dt)
    const altitudeDerivative = (altitudeError - this.lastAltitudeError) / dt
    const altitudeOutput =
      this.config.altitudePID.kp * altitudeError +
      this.config.altitudePID.ki * this.altitudeIntegral +
      this.config.altitudePID.kd * altitudeDerivative
    this.lastAltitudeError = altitudeError

    const baseThrottle = 0.5 + altitudeOutput * 0.1

    return mixQuadMotorCommands(baseThrottle, rollOutput, pitchOutput, yawOutput)
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
