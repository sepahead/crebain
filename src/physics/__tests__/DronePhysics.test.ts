import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

// Provide just enough of Rapier to cover both the fallback and successful-init
// paths without loading WASM in this focused unit suite.
const rapierMock = vi.hoisted(() => {
  const init = vi.fn()
  const fixedBodyDescription = {}
  const colliderDescription = {
    setTranslation: vi.fn(() => colliderDescription),
  }
  const world = {
    timestep: 0,
    createRigidBody: vi.fn(() => ({})),
    createCollider: vi.fn(() => ({})),
    removeRigidBody: vi.fn(),
    step: vi.fn(),
    free: vi.fn(),
  }

  return {
    init,
    world,
    World: vi.fn(function RapierWorldMock() {
      return world
    }),
    fixed: vi.fn(() => fixedBodyDescription),
    cuboid: vi.fn(() => colliderDescription),
  }
})

vi.mock('@dimforge/rapier3d-compat', () => ({
  init: rapierMock.init,
  World: rapierMock.World,
  RigidBodyDesc: { fixed: rapierMock.fixed },
  ColliderDesc: { cuboid: rapierMock.cuboid },
}))

import {
  DEFAULT_QUADCOPTER_PARAMS,
  DronePhysicsBody,
  DronePhysicsWorld,
  FlightController,
  PHYSICS_FIXED_DT,
  mixQuadMotorCommands,
  type MotorCommands,
} from '../DronePhysics'

const ZERO_COMMANDS: MotorCommands = {
  front_left: 0,
  front_right: 0,
  rear_left: 0,
  rear_right: 0,
}

type WorldInternals = {
  RAPIER: unknown
  applyDroneForces(drone: DronePhysicsBody, dt: number): void
}

type WorldUpdateInternals = WorldInternals & {
  world: { step(): void } | null
  drones: Map<string, DronePhysicsBody>
  lastUpdate: number
  accumulator: number
  isInitialized: boolean
  update(): void
}

interface FakeVector {
  x: number
  y: number
  z: number
}

function createFakeRigidBody() {
  const callOrder: string[] = []
  return {
    callOrder,
    resetForces: vi.fn(() => callOrder.push('resetForces')),
    resetTorques: vi.fn(() => callOrder.push('resetTorques')),
    addForce: vi.fn((_force: FakeVector) => callOrder.push('addForce')),
    addTorque: vi.fn((_torque: FakeVector) => callOrder.push('addTorque')),
    translation: vi.fn(() => ({ x: 0, y: 10, z: 0 })),
    rotation: vi.fn(() => ({ x: 0, y: 0, z: 0, w: 1 })),
    linvel: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
    angvel: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
  }
}

function attachFakeRigidBody(
  drone: DronePhysicsBody,
  fake: ReturnType<typeof createFakeRigidBody>
) {
  drone.rigidBody = fake as unknown as NonNullable<DronePhysicsBody['rigidBody']>
}

function torqueFromMixedControls(roll: number, pitch: number, yaw: number): FakeVector {
  const world = new DronePhysicsWorld() as unknown as WorldInternals
  world.RAPIER = {}

  const drone = new DronePhysicsBody(`mixed-${roll}-${pitch}-${yaw}`)
  drone.setArmed(true)
  drone.setMotorCommands(mixQuadMotorCommands(0.5, roll, pitch, yaw))
  const fakeBody = createFakeRigidBody()
  attachFakeRigidBody(drone, fakeBody)

  world.applyDroneForces(drone, PHYSICS_FIXED_DT)
  return fakeBody.addTorque.mock.calls[0][0]
}

describe('canonical quad mixer', () => {
  it('uses the documented local rotor mapping and clamps every command', () => {
    const commands = mixQuadMotorCommands(0.5, 0.1, 0.2, 0.05)

    expect(commands.front_left).toBeCloseTo(0.35, 12)
    expect(commands.front_right).toBeCloseTo(0.25, 12)
    expect(commands.rear_left).toBeCloseTo(0.85, 12)
    expect(commands.rear_right).toBeCloseTo(0.55, 12)
    expect(mixQuadMotorCommands(0.5, 2, -2, 2)).toEqual({
      front_left: 1,
      front_right: 1,
      rear_left: 1,
      rear_right: 0,
    })
  })

  it('stores rotors in truthful FL, FR, RL, RR order with diagonal spin pairs', () => {
    const { armLength } = DEFAULT_QUADCOPTER_PARAMS
    const drone = new DronePhysicsBody('rotor-layout')

    expect(
      drone.state.rotors.map((rotor) => [
        rotor.position.x,
        rotor.position.y,
        rotor.position.z,
        rotor.direction,
      ])
    ).toEqual([
      [-armLength, 0, armLength, -1],
      [armLength, 0, armLength, 1],
      [-armLength, 0, -armLength, 1],
      [armLength, 0, -armLength, -1],
    ])
  })

  it('turns positive right-bank roll into -Z lever torque only', () => {
    const torque = torqueFromMixedControls(0.1, 0, 0)

    expect(torque.z).toBeLessThan(0)
    expect(torque.x).toBeCloseTo(0, 12)
    expect(torque.y).toBeCloseTo(0, 12)
  })

  it('turns positive pitch into +X lever torque only', () => {
    const torque = torqueFromMixedControls(0, 0.1, 0)

    expect(torque.x).toBeGreaterThan(0)
    expect(torque.y).toBeCloseTo(0, 12)
    expect(torque.z).toBeCloseTo(0, 12)
  })

  it('turns positive yaw into +Y reaction torque with no lever-arm torque', () => {
    const torque = torqueFromMixedControls(0, 0, 0.1)

    expect(torque.y).toBeGreaterThan(0)
    expect(torque.x).toBeCloseTo(0, 12)
    expect(torque.z).toBeCloseTo(0, 12)
  })
})

describe('DronePhysicsBody local integrator', () => {
  it('integrates gravity while disarmed instead of hanging mid-air', () => {
    const body = new DronePhysicsBody('drone-1', undefined, new THREE.Vector3(0, 10, 0))
    body.setArmed(false)

    const dt = PHYSICS_FIXED_DT
    for (let i = 0; i < 120; i++) {
      body.updatePhysics(dt)
    }

    expect(body.state.velocity.y).toBeLessThan(-5)
    expect(body.state.position.y).toBeLessThan(10)
    for (const rotor of body.state.rotors) {
      expect(rotor.rpm).toBe(0)
      expect(rotor.thrust).toBe(0)
      expect(rotor.torque).toBe(0)
    }
  })

  it('clamps a disarmed drone at ground level after falling', () => {
    const body = new DronePhysicsBody('drone-2', undefined, new THREE.Vector3(0, 2, 0))
    body.setArmed(false)

    const dt = PHYSICS_FIXED_DT
    for (let i = 0; i < 600; i++) {
      body.updatePhysics(dt)
    }

    expect(body.state.position.y).toBeCloseTo(0.1, 6)
  })

  it('applies rotor lever-arm torque proportional to thrust (not thrust squared)', () => {
    const body = new DronePhysicsBody('drone-3', undefined, new THREE.Vector3(0, 10, 0))
    body.setArmed(true)
    body.setMotorCommands({ ...ZERO_COMMANDS, front_left: 1 })

    const dt = PHYSICS_FIXED_DT
    body.updatePhysics(dt)

    const { armLength, momentOfInertia } = DEFAULT_QUADCOPTER_PARAMS
    const thrust = body.state.rotors[0].thrust
    expect(thrust).toBeGreaterThan(0)

    // Front-left rotor at (-arm, 0, +arm), thrust along +Y:
    // torque = leverArm x (0, thrust, 0) = (-arm * thrust, 0, -arm * thrust).
    // Angular velocity after one step = (torque / I) * dt * damping(0.98).
    const expectedAngVelX = ((-armLength * thrust) / momentOfInertia.x) * dt * 0.98
    const expectedAngVelZ = ((-armLength * thrust) / momentOfInertia.z) * dt * 0.98
    expect(body.state.angularVelocity.x).toBeCloseTo(expectedAngVelX, 10)
    expect(body.state.angularVelocity.z).toBeCloseTo(expectedAngVelZ, 10)
  })
})

describe('DronePhysicsWorld Rapier force application', () => {
  it('applies forces before advancing exactly one fixed Rapier step', () => {
    const world = new DronePhysicsWorld() as unknown as WorldUpdateInternals
    const drone = new DronePhysicsBody('ordered-step')
    drone.setArmed(true)
    drone.setMotorCommands(mixQuadMotorCommands(0.5, 0, 0, 0))
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)

    const fakeWorld = {
      step: vi.fn(() => fakeBody.callOrder.push('step')),
    }
    world.RAPIER = {}
    world.world = fakeWorld
    world.drones.set(drone.id, drone)
    world.lastUpdate = 1000
    world.accumulator = PHYSICS_FIXED_DT
    world.isInitialized = true
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)

    try {
      world.update()
    } finally {
      now.mockRestore()
    }

    expect(fakeWorld.step).toHaveBeenCalledTimes(1)
    expect(fakeBody.callOrder).toEqual([
      'resetForces',
      'resetTorques',
      'addForce',
      'addTorque',
      'step',
    ])
    expect(world.accumulator).toBeCloseTo(0, 12)
  })

  it('resets persistent Rapier forces and torques before applying each step', () => {
    const world = new DronePhysicsWorld() as unknown as WorldInternals
    world.RAPIER = {}

    const drone = new DronePhysicsBody('drone-4')
    drone.setArmed(true)
    drone.setMotorCommands({ front_left: 1, front_right: 1, rear_left: 1, rear_right: 1 })
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)

    const dt = PHYSICS_FIXED_DT
    world.applyDroneForces(drone, dt)
    world.applyDroneForces(drone, dt)

    expect(fakeBody.resetForces).toHaveBeenCalledTimes(2)
    expect(fakeBody.resetTorques).toHaveBeenCalledTimes(2)
    expect(fakeBody.addForce).toHaveBeenCalledTimes(2)
    expect(fakeBody.callOrder).toEqual([
      'resetForces',
      'resetTorques',
      'addForce',
      'addTorque',
      'resetForces',
      'resetTorques',
      'addForce',
      'addTorque',
    ])
  })

  it('clears forces but applies none while disarmed', () => {
    const world = new DronePhysicsWorld() as unknown as WorldInternals
    world.RAPIER = {}

    const drone = new DronePhysicsBody('drone-5')
    drone.setArmed(false)
    drone.state.rotors[0].rpm = 5000
    drone.state.rotors[0].thrust = 3
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)

    world.applyDroneForces(drone, PHYSICS_FIXED_DT)

    expect(fakeBody.resetForces).toHaveBeenCalledTimes(1)
    expect(fakeBody.resetTorques).toHaveBeenCalledTimes(1)
    expect(fakeBody.addForce).not.toHaveBeenCalled()
    expect(fakeBody.addTorque).not.toHaveBeenCalled()
    expect(drone.state.rotors[0].rpm).toBe(0)
    expect(drone.state.rotors[0].thrust).toBe(0)
  })

  it('applies rotor lever-arm torque proportional to thrust in the Rapier path', () => {
    const world = new DronePhysicsWorld() as unknown as WorldInternals
    world.RAPIER = {}

    const drone = new DronePhysicsBody('drone-6')
    drone.setArmed(true)
    drone.setMotorCommands({ ...ZERO_COMMANDS, front_left: 1 })
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)

    world.applyDroneForces(drone, PHYSICS_FIXED_DT)

    const { armLength } = DEFAULT_QUADCOPTER_PARAMS
    const thrust = drone.state.rotors[0].thrust
    expect(thrust).toBeGreaterThan(0)

    const torqueArg = fakeBody.addTorque.mock.calls[0][0]
    expect(torqueArg.x).toBeCloseTo(-armLength * thrust, 10)
    expect(torqueArg.z).toBeCloseTo(-armLength * thrust, 10)
  })
})

describe('DronePhysicsWorld initialization', () => {
  it('falls back after an init failure, then retries with the fixed timestep', async () => {
    rapierMock.init.mockRejectedValueOnce(new Error('wasm init failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fallbackWorld = new DronePhysicsWorld()

    try {
      await fallbackWorld.init()

      expect(fallbackWorld.isReady()).toBe(true)
      expect(fallbackWorld.isUsingFallback()).toBe(true)
      expect(consoleError).toHaveBeenCalledWith(
        '[Physics]',
        expect.stringContaining('Rapier physics init failed'),
        expect.objectContaining({ error: expect.any(Error) })
      )
    } finally {
      consoleError.mockRestore()
    }

    rapierMock.init.mockResolvedValueOnce(undefined)
    const retryWorld = new DronePhysicsWorld()

    await retryWorld.init()

    expect(retryWorld.isReady()).toBe(true)
    expect(retryWorld.isUsingFallback()).toBe(false)
    expect(rapierMock.init).toHaveBeenCalledTimes(2)
    expect(rapierMock.world.timestep).toBe(PHYSICS_FIXED_DT)

    retryWorld.destroy()
  })
})

describe('FlightController PID state', () => {
  type ControllerInternals = {
    rollIntegral: number
    pitchIntegral: number
    yawIntegral: number
    altitudeIntegral: number
  }

  it('clamps all PID integrals against windup', () => {
    const controller = new FlightController()
    const internals = controller as unknown as ControllerInternals
    const drone = new DronePhysicsBody('drone-7', undefined, new THREE.Vector3(0, 0.1, 0))
    drone.setArmed(true)

    // Large persistent errors on every axis for 100 simulated seconds.
    for (let i = 0; i < 1000; i++) {
      controller.update(drone, 1, 1, 5, 100, 0.1)
    }

    expect(Math.abs(internals.rollIntegral)).toBeLessThanOrEqual(10)
    expect(Math.abs(internals.pitchIntegral)).toBeLessThanOrEqual(10)
    expect(Math.abs(internals.yawIntegral)).toBeLessThanOrEqual(10)
    expect(Math.abs(internals.altitudeIntegral)).toBeLessThanOrEqual(10)
  })

  it('resets PID state and outputs zero commands while disarmed', () => {
    const controller = new FlightController()
    const internals = controller as unknown as ControllerInternals
    const drone = new DronePhysicsBody('drone-8', undefined, new THREE.Vector3(0, 0.1, 0))
    drone.setArmed(true)

    for (let i = 0; i < 100; i++) {
      controller.update(drone, 1, 1, 5, 100, 0.1)
    }
    expect(internals.yawIntegral).not.toBe(0)

    drone.setArmed(false)
    const commands = controller.update(drone, 1, 1, 5, 100, 0.1)

    expect(commands).toEqual(ZERO_COMMANDS)
    expect(internals.rollIntegral).toBe(0)
    expect(internals.pitchIntegral).toBe(0)
    expect(internals.yawIntegral).toBe(0)
    expect(internals.altitudeIntegral).toBe(0)
  })

  it('routes PID outputs through the canonical quad mixer', () => {
    const controller = new FlightController({
      rollPID: { kp: 0.1, ki: 0, kd: 0 },
      pitchPID: { kp: 0.1, ki: 0, kd: 0 },
      yawPID: { kp: 0.1, ki: 0, kd: 0 },
      altitudePID: { kp: 0, ki: 0, kd: 0 },
      maxAngle: 1,
    })
    const drone = new DronePhysicsBody('controller-mixer', undefined, new THREE.Vector3(0, 1, 0))
    drone.setArmed(true)

    const commands = controller.update(drone, 1, 0, 0, 1, 0.1)

    expect(commands).toEqual(mixQuadMotorCommands(0.5, 0.1, 0, 0))
  })

  it('reads a Three.js -Z bank as positive logical roll and commands restoring torque', () => {
    const controller = new FlightController({
      rollPID: { kp: 0.1, ki: 0, kd: 0 },
      pitchPID: { kp: 0, ki: 0, kd: 0 },
      yawPID: { kp: 0, ki: 0, kd: 0 },
      altitudePID: { kp: 0, ki: 0, kd: 0 },
      maxAngle: 1,
    })
    const drone = new DronePhysicsBody('right-bank-feedback', undefined, new THREE.Vector3(0, 1, 0))
    drone.setArmed(true)
    drone.state.orientation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.1)

    const commands = controller.update(drone, 0, 0, 0, 1, 0.1)
    drone.setMotorCommands(commands)
    const world = new DronePhysicsWorld() as unknown as WorldInternals
    world.RAPIER = {}
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)
    world.applyDroneForces(drone, PHYSICS_FIXED_DT)

    expect(fakeBody.addTorque.mock.calls[0][0].z).toBeGreaterThan(0)
  })

  it('accelerates toward local +X for a positive right-bank target', () => {
    const controller = new FlightController({
      rollPID: { kp: 0.1, ki: 0, kd: 0 },
      pitchPID: { kp: 0, ki: 0, kd: 0 },
      yawPID: { kp: 0, ki: 0, kd: 0 },
      altitudePID: { kp: 0, ki: 0, kd: 0 },
      maxAngle: 1,
    })
    const drone = new DronePhysicsBody(
      'right-bank-motion',
      { ...DEFAULT_QUADCOPTER_PARAMS, dragCoefficient: 0 },
      new THREE.Vector3(0, 10, 0)
    )
    drone.setArmed(true)

    for (let step = 0; step < 30; step++) {
      drone.setMotorCommands(controller.update(drone, 0.1, 0, 0, 10, PHYSICS_FIXED_DT))
      drone.updatePhysics(PHYSICS_FIXED_DT)
    }

    expect(drone.state.position.x).toBeGreaterThan(0)
    expect(drone.state.velocity.x).toBeGreaterThan(0)
  })

  it('decelerates local +X drift with the hands-off lateral braking target', () => {
    const controller = new FlightController({
      rollPID: { kp: 0.1, ki: 0, kd: 0 },
      pitchPID: { kp: 0, ki: 0, kd: 0 },
      yawPID: { kp: 0, ki: 0, kd: 0 },
      altitudePID: { kp: 0, ki: 0, kd: 0 },
      maxAngle: 1,
    })
    const drone = new DronePhysicsBody(
      'lateral-brake',
      { ...DEFAULT_QUADCOPTER_PARAMS, dragCoefficient: 0 },
      new THREE.Vector3(0, 10, 0)
    )
    drone.setArmed(true)
    drone.state.velocity.x = 0.1

    for (let step = 0; step < 30; step++) {
      const targetRoll = -drone.state.velocity.x * 0.35
      drone.setMotorCommands(controller.update(drone, targetRoll, 0, 0, 10, PHYSICS_FIXED_DT))
      drone.updatePhysics(PHYSICS_FIXED_DT)
    }

    expect(drone.state.velocity.x).toBeLessThan(0.1)
  })
})
