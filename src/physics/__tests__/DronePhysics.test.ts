import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

// Simulate a Rapier WASM init failure so the fallback path is exercised.
// The tests below never need a real Rapier world: the Rapier-path force
// application is verified against a fake rigid body.
const rapierInitMock = vi.hoisted(() => vi.fn())
vi.mock('@dimforge/rapier3d-compat', () => ({ init: rapierInitMock }))

import {
  DEFAULT_QUADCOPTER_PARAMS,
  DronePhysicsBody,
  DronePhysicsWorld,
  FlightController,
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
  }
}

function attachFakeRigidBody(
  drone: DronePhysicsBody,
  fake: ReturnType<typeof createFakeRigidBody>
) {
  drone.rigidBody = fake as unknown as NonNullable<DronePhysicsBody['rigidBody']>
}

describe('DronePhysicsBody local integrator', () => {
  it('integrates gravity while disarmed instead of hanging mid-air', () => {
    const body = new DronePhysicsBody('drone-1', undefined, new THREE.Vector3(0, 10, 0))
    body.setArmed(false)

    const dt = 1 / 120
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

    const dt = 1 / 120
    for (let i = 0; i < 600; i++) {
      body.updatePhysics(dt)
    }

    expect(body.state.position.y).toBeCloseTo(0.1, 6)
  })

  it('applies rotor lever-arm torque proportional to thrust (not thrust squared)', () => {
    const body = new DronePhysicsBody('drone-3', undefined, new THREE.Vector3(0, 10, 0))
    body.setArmed(true)
    body.setMotorCommands({ ...ZERO_COMMANDS, front_left: 1 })

    const dt = 1 / 120
    body.updatePhysics(dt)

    const { armLength, momentOfInertia } = DEFAULT_QUADCOPTER_PARAMS
    const thrust = body.state.rotors[0].thrust
    expect(thrust).toBeGreaterThan(0)

    // Rotor 0 at (+arm, 0, +arm), thrust along +Y (identity orientation):
    // torque = leverArm x (0, thrust, 0) = (-arm * thrust, 0, arm * thrust).
    // Angular velocity after one step = (torque / I) * dt * damping(0.98).
    const expectedAngVelX = ((-armLength * thrust) / momentOfInertia.x) * dt * 0.98
    const expectedAngVelZ = ((armLength * thrust) / momentOfInertia.z) * dt * 0.98
    expect(body.state.angularVelocity.x).toBeCloseTo(expectedAngVelX, 10)
    expect(body.state.angularVelocity.z).toBeCloseTo(expectedAngVelZ, 10)
  })
})

describe('DronePhysicsWorld Rapier force application', () => {
  it('resets persistent Rapier forces and torques before applying each step', () => {
    const world = new DronePhysicsWorld() as unknown as WorldInternals
    world.RAPIER = {}

    const drone = new DronePhysicsBody('drone-4')
    drone.setArmed(true)
    drone.setMotorCommands({ front_left: 1, front_right: 1, rear_left: 1, rear_right: 1 })
    const fakeBody = createFakeRigidBody()
    attachFakeRigidBody(drone, fakeBody)

    const dt = 1 / 120
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

    world.applyDroneForces(drone, 1 / 120)

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

    world.applyDroneForces(drone, 1 / 120)

    const { armLength } = DEFAULT_QUADCOPTER_PARAMS
    const thrust = drone.state.rotors[0].thrust
    expect(thrust).toBeGreaterThan(0)

    const torqueArg = fakeBody.addTorque.mock.calls[0][0]
    expect(torqueArg.x).toBeCloseTo(-armLength * thrust, 10)
    expect(torqueArg.z).toBeCloseTo(armLength * thrust, 10)
  })
})

describe('DronePhysicsWorld init fallback', () => {
  it('logs the Rapier init failure and reports the fallback flag', async () => {
    rapierInitMock.mockRejectedValueOnce(new Error('wasm init failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const world = new DronePhysicsWorld()

    try {
      await world.init()

      expect(world.isReady()).toBe(true)
      expect(world.isUsingFallback()).toBe(true)
      expect(consoleError).toHaveBeenCalledWith(
        '[Physics]',
        expect.stringContaining('Rapier physics init failed'),
        expect.objectContaining({ error: expect.any(Error) })
      )
    } finally {
      consoleError.mockRestore()
    }
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
})
