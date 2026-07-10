/**
 * CREBAIN Drone Types System
 * Defines different drone configurations: quadcopter, fixed-wing, loitering munition
 */

import * as THREE from 'three'
import type { QuadcopterParams } from './DronePhysics'

// ─────────────────────────────────────────────────────────────────────────────
// DRONE TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export type DroneCategory =
  'quadcopter' | 'fixed_wing' | 'loitering_munition' | 'hexacopter' | 'vtol'

export interface DroneTypeDefinition {
  id: string
  name: string
  category: DroneCategory
  description: string
  modelPath: string // GLB/GLTF model path
  thumbnailPath?: string // Preview image
  physics: DronePhysicsConfig
  sensors: DroneSensorConfig
  capabilities: DroneCapabilities
}

export interface DronePhysicsConfig {
  mass: number // kg
  dimensions: THREE.Vector3 // meters (width, height, length)
  maxSpeed: number // m/s
  maxAltitude: number // meters
  endurance: number // minutes

  // For multirotors
  armLength?: number // m
  rotorCount?: number
  maxThrust?: number // N per rotor

  // For fixed-wing
  wingspan?: number // m
  stallSpeed?: number // m/s
  glideRatio?: number

  // Aerodynamics
  dragCoefficient: number
  liftCoefficient?: number
  momentOfInertia: THREE.Vector3
}

export interface DroneSensorConfig {
  hasCamera: boolean
  cameraResolution?: [number, number] // [width, height]
  cameraFOV?: number // degrees
  hasGPS: boolean
  gpsAccuracy?: number // meters CEP
  hasIMU: boolean
  imuNoiseLevel?: number // deg/s gyro noise
  hasBarometer: boolean
  hasMagnetometer: boolean
  hasLidar?: boolean
  lidarRange?: number // meters
  hasIR?: boolean // Infrared
}

export interface DroneCapabilities {
  canHover: boolean
  canVTOL: boolean
  isWeaponized: boolean
  payloadCapacity: number // kg
  communicationRange: number // km
  autonomyLevel: 'manual' | 'assisted' | 'semi_autonomous' | 'fully_autonomous'
}

// ─────────────────────────────────────────────────────────────────────────────
// PREDEFINED DRONE TYPES
// ─────────────────────────────────────────────────────────────────────────────

export const DRONE_TYPES: Record<string, DroneTypeDefinition> = {
  // DJI Maverick-style quadcopter
  maverick: {
    id: 'maverick',
    name: 'Maverick Quadcopter',
    category: 'quadcopter',
    description: 'DJI-style consumer/prosumer quadcopter with 4K camera',
    modelPath: '/models/maverick-drone.glb',
    physics: {
      mass: 0.9,
      dimensions: new THREE.Vector3(0.35, 0.1, 0.35),
      maxSpeed: 20,
      maxAltitude: 500,
      endurance: 30,
      armLength: 0.175,
      rotorCount: 4,
      maxThrust: 5,
      dragCoefficient: 0.8,
      momentOfInertia: new THREE.Vector3(0.005, 0.01, 0.005),
    },
    sensors: {
      hasCamera: true,
      cameraResolution: [3840, 2160],
      cameraFOV: 84,
      hasGPS: true,
      gpsAccuracy: 2,
      hasIMU: true,
      imuNoiseLevel: 0.01,
      hasBarometer: true,
      hasMagnetometer: true,
    },
    capabilities: {
      canHover: true,
      canVTOL: true,
      isWeaponized: false,
      payloadCapacity: 0.5,
      communicationRange: 10,
      autonomyLevel: 'assisted',
    },
  },

  // Shahed-136 style loitering munition
  shahed: {
    id: 'shahed',
    name: 'Shahed-136 Loitering Munition',
    category: 'loitering_munition',
    description: 'Delta-wing loitering munition with pusher propeller',
    modelPath: '/models/shahed-drone.glb', // Would need to be created/imported
    physics: {
      mass: 200,
      dimensions: new THREE.Vector3(2.5, 0.5, 2.0),
      maxSpeed: 46, // ~185 km/h
      maxAltitude: 4000,
      endurance: 180, // ~2500km range
      wingspan: 2.5,
      stallSpeed: 25,
      glideRatio: 8,
      dragCoefficient: 0.3,
      liftCoefficient: 1.2,
      momentOfInertia: new THREE.Vector3(50, 100, 50),
    },
    sensors: {
      hasCamera: true,
      cameraResolution: [1920, 1080],
      cameraFOV: 60,
      hasGPS: true,
      gpsAccuracy: 5,
      hasIMU: true,
      imuNoiseLevel: 0.05,
      hasBarometer: true,
      hasMagnetometer: true,
    },
    capabilities: {
      canHover: false,
      canVTOL: false,
      isWeaponized: true,
      payloadCapacity: 40, // Warhead
      communicationRange: 150,
      autonomyLevel: 'semi_autonomous',
    },
  },

  // FPV Racing Drone
  fpv_racer: {
    id: 'fpv_racer',
    name: 'FPV Racing Drone',
    category: 'quadcopter',
    description: 'High-speed FPV racing quadcopter',
    modelPath: '/models/fpv-drone.glb',
    physics: {
      mass: 0.5,
      dimensions: new THREE.Vector3(0.25, 0.08, 0.25),
      maxSpeed: 45, // ~160 km/h
      maxAltitude: 200,
      endurance: 8,
      armLength: 0.125,
      rotorCount: 4,
      maxThrust: 8,
      dragCoefficient: 0.6,
      momentOfInertia: new THREE.Vector3(0.002, 0.004, 0.002),
    },
    sensors: {
      hasCamera: true,
      cameraResolution: [1280, 720],
      cameraFOV: 120,
      hasGPS: false,
      hasIMU: true,
      imuNoiseLevel: 0.02,
      hasBarometer: false,
      hasMagnetometer: false,
    },
    capabilities: {
      canHover: true,
      canVTOL: true,
      isWeaponized: false,
      payloadCapacity: 0,
      communicationRange: 2,
      autonomyLevel: 'manual',
    },
  },

  // Reconnaissance-oriented hexacopter
  recon_hex: {
    id: 'recon_hex',
    name: 'Reconnaissance Hexacopter',
    category: 'hexacopter',
    description: 'Hexacopter profile for ISR-style simulation scenarios',
    modelPath: '/models/recon-hex.glb',
    physics: {
      mass: 8,
      dimensions: new THREE.Vector3(1.2, 0.4, 1.2),
      maxSpeed: 25,
      maxAltitude: 3000,
      endurance: 45,
      armLength: 0.6,
      rotorCount: 6,
      maxThrust: 25,
      dragCoefficient: 1.2,
      momentOfInertia: new THREE.Vector3(0.5, 1.0, 0.5),
    },
    sensors: {
      hasCamera: true,
      cameraResolution: [4096, 2160],
      cameraFOV: 70,
      hasGPS: true,
      gpsAccuracy: 0.5, // RTK GPS
      hasIMU: true,
      imuNoiseLevel: 0.005,
      hasBarometer: true,
      hasMagnetometer: true,
      hasLidar: true,
      lidarRange: 100,
      hasIR: true,
    },
    capabilities: {
      canHover: true,
      canVTOL: true,
      isWeaponized: false,
      payloadCapacity: 3,
      communicationRange: 50,
      autonomyLevel: 'fully_autonomous',
    },
  },

  // Switchblade-style loitering munition
  switchblade: {
    id: 'switchblade',
    name: 'Switchblade 600',
    category: 'loitering_munition',
    description: 'Tube-launched loitering munition',
    modelPath: '/models/switchblade.glb',
    physics: {
      mass: 23,
      dimensions: new THREE.Vector3(1.3, 0.15, 1.0),
      maxSpeed: 55,
      maxAltitude: 4500,
      endurance: 40,
      wingspan: 1.3,
      stallSpeed: 20,
      glideRatio: 10,
      dragCoefficient: 0.25,
      liftCoefficient: 1.4,
      momentOfInertia: new THREE.Vector3(2, 4, 2),
    },
    sensors: {
      hasCamera: true,
      cameraResolution: [1920, 1080],
      cameraFOV: 50,
      hasGPS: true,
      gpsAccuracy: 1,
      hasIMU: true,
      imuNoiseLevel: 0.01,
      hasBarometer: true,
      hasMagnetometer: true,
      hasIR: true,
    },
    capabilities: {
      canHover: false,
      canVTOL: false,
      isWeaponized: true,
      payloadCapacity: 5,
      communicationRange: 40,
      autonomyLevel: 'semi_autonomous',
    },
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert DroneTypeDefinition to QuadcopterParams for physics simulation
 */
export function toQuadcopterParams(droneType: DroneTypeDefinition): QuadcopterParams {
  const physics = droneType.physics

  return {
    mass: physics.mass,
    armLength: physics.armLength || physics.dimensions.x / 2,
    rotorRadius: 0.127, // 5" default
    maxThrust: physics.maxThrust || physics.mass * 2.5, // ~2.5:1 thrust ratio
    maxTorque: 0.5,
    dragCoefficient: physics.dragCoefficient,
    crossSectionArea: physics.dimensions.x * physics.dimensions.z * 0.5,
    momentOfInertia: physics.momentOfInertia.clone(),
    thrustCoefficient: 1.91e-6,
    torqueCoefficient: 2.6e-7,
  }
}

/**
 * Get all drone types of a specific category
 */
export function getDronesByCategory(category: DroneCategory): DroneTypeDefinition[] {
  return Object.values(DRONE_TYPES).filter((d) => d.category === category)
}

/**
 * Get drone type by ID
 */
export function getDroneType(id: string): DroneTypeDefinition | undefined {
  return DRONE_TYPES[id]
}

export default DRONE_TYPES
