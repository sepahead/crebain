/**
 * CREBAIN High-Fidelity Sensor Simulation
 * Realistic sensor models with noise, bias, and latency
 */

import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────────────────
// NOISE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Box-Muller transform for Gaussian random numbers */
function gaussianRandom(mean: number = 0, stdDev: number = 1): number {
  // Math.random() is in [0, 1); map to (0, 1] so Math.log(u1) can never be
  // -Infinity (which would inject Infinity into readings and bias walks).
  const u1 = 1 - Math.random()
  const u2 = Math.random()
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)
  return z0 * stdDev + mean
}

/** Generate 3D Gaussian noise vector */
function gaussianVector3(stdDev: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    gaussianRandom(0, stdDev.x),
    gaussianRandom(0, stdDev.y),
    gaussianRandom(0, stdDev.z)
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LATENCY UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the newest buffered reading that is at least latencyMs old.
 *
 * Selecting by timestamp (instead of by buffer index) keeps the simulated
 * latency honest regardless of the rate at which the caller fills the buffer.
 * Returns null when no reading is old enough yet.
 */
function selectDelayedReading<T extends { timestamp: number }>(
  buffer: T[],
  latencyMs: number
): T | null {
  const cutoff = performance.now() - latencyMs
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].timestamp <= cutoff) {
      return buffer[i]
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// IMU SENSOR SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

export interface IMUConfig {
  updateRate: number // Hz
  gyroNoiseStdDev: THREE.Vector3 // rad/s
  gyroBias: THREE.Vector3 // rad/s (constant bias)
  gyroBiasInstability: number // rad/s (random walk)
  accelNoiseStdDev: THREE.Vector3 // m/s²
  accelBias: THREE.Vector3 // m/s² (constant bias)
  accelBiasInstability: number // m/s² (random walk)
  latencyMs: number // Processing latency
}

export const DEFAULT_IMU_CONFIG: IMUConfig = {
  updateRate: 200,
  gyroNoiseStdDev: new THREE.Vector3(0.01, 0.01, 0.01), // ~0.6 deg/s
  gyroBias: new THREE.Vector3(0.001, -0.002, 0.001), // Constant bias
  gyroBiasInstability: 0.0001, // Bias drift
  accelNoiseStdDev: new THREE.Vector3(0.05, 0.05, 0.05), // ~0.05 m/s²
  accelBias: new THREE.Vector3(0.01, -0.02, 0.01), // Constant bias
  accelBiasInstability: 0.001, // Bias drift
  latencyMs: 2,
}

export interface IMUReading {
  timestamp: number
  angularVelocity: THREE.Vector3 // rad/s (body frame)
  linearAcceleration: THREE.Vector3 // m/s² (body frame, includes gravity)
  temperature: number // Celsius (affects bias)
}

/** Max buffered IMU readings for the latency model (50ms at 200Hz). */
const IMU_READING_BUFFER_SIZE = 10

export class IMUSensor {
  private config: IMUConfig
  private currentGyroBias: THREE.Vector3
  private currentAccelBias: THREE.Vector3
  private readingBuffer: IMUReading[] = []
  private lastReading: IMUReading | null = null
  private timeSinceLastReading: number = 0

  constructor(config: IMUConfig = DEFAULT_IMU_CONFIG) {
    this.config = config
    this.currentGyroBias = config.gyroBias.clone()
    this.currentAccelBias = config.accelBias.clone()
  }

  /**
   * Generate IMU reading from true state.
   *
   * New readings are produced at the configured updateRate regardless of how
   * often the caller invokes this (dt accumulation); between sensor ticks the
   * most recent reading is returned unchanged, matching a real sensor that
   * holds its output until the next sample.
   */
  update(
    trueAngularVelocity: THREE.Vector3,
    trueAcceleration: THREE.Vector3,
    orientation: THREE.Quaternion,
    dt: number
  ): IMUReading {
    this.timeSinceLastReading += dt
    if (this.lastReading && this.timeSinceLastReading < 1 / this.config.updateRate) {
      return this.lastReading
    }
    const elapsed = this.timeSinceLastReading
    this.timeSinceLastReading = 0

    const now = performance.now()

    // Update bias random walk over the time actually elapsed since the last
    // generated reading
    this.currentGyroBias.add(
      gaussianVector3(
        new THREE.Vector3(
          this.config.gyroBiasInstability * elapsed,
          this.config.gyroBiasInstability * elapsed,
          this.config.gyroBiasInstability * elapsed
        )
      )
    )
    this.currentAccelBias.add(
      gaussianVector3(
        new THREE.Vector3(
          this.config.accelBiasInstability * elapsed,
          this.config.accelBiasInstability * elapsed,
          this.config.accelBiasInstability * elapsed
        )
      )
    )

    // Transform to body frame
    const invOrientation = orientation.clone().invert()
    const bodyAngularVelocity = trueAngularVelocity.clone().applyQuaternion(invOrientation)

    // IMU measures specific force f = a - g, where gravity g points DOWN (-Y).
    // trueAcceleration already includes the gravity force, so
    // f = a - (0,-9.81,0) = a + (0,9.81,0): at rest the accelerometer reads
    // +1g on the up axis, as a real IMU does.
    const gravity = new THREE.Vector3(0, -9.81, 0)
    const specificForce = trueAcceleration.clone().sub(gravity)
    const bodyAcceleration = specificForce.applyQuaternion(invOrientation)

    // Add noise and bias
    const noisyGyro = bodyAngularVelocity
      .add(this.currentGyroBias)
      .add(gaussianVector3(this.config.gyroNoiseStdDev))

    const noisyAccel = bodyAcceleration
      .add(this.currentAccelBias)
      .add(gaussianVector3(this.config.accelNoiseStdDev))

    const reading: IMUReading = {
      timestamp: now,
      angularVelocity: noisyGyro,
      linearAcceleration: noisyAccel,
      temperature: 25 + gaussianRandom(0, 0.5),
    }

    // Simulate latency buffer
    this.readingBuffer.push(reading)
    if (this.readingBuffer.length > IMU_READING_BUFFER_SIZE) {
      this.readingBuffer.shift()
    }

    this.lastReading = reading
    return reading
  }

  /**
   * Get delayed reading (simulates processing latency).
   *
   * Selects by timestamp: the newest reading at least latencyMs old. Returns
   * null until the sensor has been running long enough to have one.
   */
  getDelayedReading(): IMUReading | null {
    return selectDelayedReading(this.readingBuffer, this.config.latencyMs)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS SENSOR SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

export interface GPSConfig {
  updateRate: number // Hz (typically 1-10)
  horizontalAccuracy: number // meters CEP (50% of readings within)
  verticalAccuracy: number // meters
  velocityAccuracy: number // m/s
  latencyMs: number // ~100-500ms typical
  dropoutProbability: number // Probability of signal loss per second
}

export const DEFAULT_GPS_CONFIG: GPSConfig = {
  updateRate: 5,
  horizontalAccuracy: 2.5,
  verticalAccuracy: 5.0,
  velocityAccuracy: 0.1,
  latencyMs: 200,
  dropoutProbability: 0.01,
}

export interface GPSReading {
  timestamp: number
  position: THREE.Vector3 // meters (local frame)
  velocity: THREE.Vector3 // m/s
  altitude: number // meters MSL
  horizontalAccuracy: number // meters (reported)
  verticalAccuracy: number // meters (reported)
  satelliteCount: number
  fixType: 'none' | '2D' | '3D' | 'DGPS' | 'RTK'
  valid: boolean
}

/** Max buffered GPS readings for the latency model (4s at 5Hz). */
const GPS_READING_BUFFER_SIZE = 20

export class GPSSensor {
  private config: GPSConfig
  private readingBuffer: GPSReading[] = []
  private signalLost: boolean = false
  private signalLostUntil: number = 0
  private lastReading: GPSReading | null = null
  private timeSinceLastReading: number = 0

  constructor(config: GPSConfig = DEFAULT_GPS_CONFIG) {
    this.config = config
  }

  /**
   * Generate GPS reading from true state.
   *
   * New readings are produced at the configured updateRate regardless of how
   * often the caller invokes this (dt accumulation); between sensor ticks the
   * most recent reading is returned unchanged, matching a real receiver that
   * holds its output until the next fix.
   */
  update(truePosition: THREE.Vector3, trueVelocity: THREE.Vector3, dt: number): GPSReading {
    this.timeSinceLastReading += dt
    if (this.lastReading && this.timeSinceLastReading < 1 / this.config.updateRate) {
      return this.lastReading
    }
    const elapsed = this.timeSinceLastReading
    this.timeSinceLastReading = 0

    const now = performance.now()

    // Check for signal dropout over the time actually elapsed since the last
    // generated reading
    if (Math.random() < this.config.dropoutProbability * elapsed) {
      this.signalLost = true
      this.signalLostUntil = now + 1000 + Math.random() * 4000 // 1-5 second dropout
    }

    if (this.signalLost && now < this.signalLostUntil) {
      const invalidReading: GPSReading = {
        timestamp: now,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        altitude: 0,
        horizontalAccuracy: 999,
        verticalAccuracy: 999,
        satelliteCount: 0,
        fixType: 'none',
        valid: false,
      }
      // A receiver dropout is itself the newest sensor output. It must traverse
      // the same latency model as valid fixes; otherwise getDelayedReading()
      // keeps exposing an older valid position after the delayed invalid fix
      // should have made signal loss observable.
      this.readingBuffer.push(invalidReading)
      if (this.readingBuffer.length > GPS_READING_BUFFER_SIZE) {
        this.readingBuffer.shift()
      }
      this.lastReading = invalidReading
      return invalidReading
    }
    this.signalLost = false

    // Add position noise (CEP to stddev: stddev ≈ CEP / 0.675)
    const horizontalStdDev = this.config.horizontalAccuracy / 0.675
    const verticalStdDev = this.config.verticalAccuracy / 0.675

    const noisyPosition = truePosition
      .clone()
      .add(
        new THREE.Vector3(
          gaussianRandom(0, horizontalStdDev),
          gaussianRandom(0, verticalStdDev),
          gaussianRandom(0, horizontalStdDev)
        )
      )

    // Add velocity noise
    const noisyVelocity = trueVelocity
      .clone()
      .add(
        new THREE.Vector3(
          gaussianRandom(0, this.config.velocityAccuracy),
          gaussianRandom(0, this.config.velocityAccuracy),
          gaussianRandom(0, this.config.velocityAccuracy)
        )
      )

    // Simulate varying accuracy based on "satellite geometry"
    const reportedHorizontalAcc = this.config.horizontalAccuracy * (0.8 + Math.random() * 0.4)
    const reportedVerticalAcc = this.config.verticalAccuracy * (0.8 + Math.random() * 0.4)

    const reading: GPSReading = {
      timestamp: now,
      position: noisyPosition,
      velocity: noisyVelocity,
      altitude: noisyPosition.y + gaussianRandom(0, verticalStdDev),
      horizontalAccuracy: reportedHorizontalAcc,
      verticalAccuracy: reportedVerticalAcc,
      satelliteCount: 8 + Math.floor(Math.random() * 6),
      fixType: '3D',
      valid: true,
    }

    // Simulate latency
    this.readingBuffer.push(reading)
    if (this.readingBuffer.length > GPS_READING_BUFFER_SIZE) {
      this.readingBuffer.shift()
    }

    this.lastReading = reading
    return reading
  }

  /**
   * Get delayed reading (simulates receiver/processing latency).
   *
   * Selects by timestamp: the newest reading at least latencyMs old. Returns
   * null until the sensor has been running long enough to have one.
   */
  getDelayedReading(): GPSReading | null {
    return selectDelayedReading(this.readingBuffer, this.config.latencyMs)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BAROMETER SENSOR SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

export interface BarometerConfig {
  updateRate: number // Hz
  altitudeNoiseStdDev: number // meters
  pressureNoiseStdDev: number // Pa
  temperatureDrift: number // meters/°C
  latencyMs: number
}

export const DEFAULT_BAROMETER_CONFIG: BarometerConfig = {
  updateRate: 50,
  altitudeNoiseStdDev: 0.5,
  pressureNoiseStdDev: 10,
  temperatureDrift: 0.1,
  latencyMs: 5,
}

export interface BarometerReading {
  timestamp: number
  pressure: number // Pa
  altitude: number // meters (pressure altitude)
  temperature: number // Celsius
}

const BAROMETER_REFERENCE_TEMPERATURE_C = 15
const MAX_BAROMETER_READING_BUFFER_SIZE = 4096

export class BarometerSensor {
  private config: BarometerConfig
  private baselinePressure: number = 101325 // Sea level Pa
  private temperatureOffset: number = 0
  private readingBuffer: BarometerReading[] = []
  private lastReading: BarometerReading | null = null
  private timeSinceLastReading = 0
  private readonly readingBufferSize: number

  constructor(config: BarometerConfig = DEFAULT_BAROMETER_CONFIG) {
    if (!Number.isFinite(config.updateRate) || config.updateRate <= 0) {
      throw new Error('Barometer updateRate must be a positive finite number')
    }
    if (!Number.isFinite(config.latencyMs) || config.latencyMs < 0) {
      throw new Error('Barometer latencyMs must be a non-negative finite number')
    }
    if (
      !Number.isFinite(config.altitudeNoiseStdDev) ||
      config.altitudeNoiseStdDev < 0 ||
      !Number.isFinite(config.pressureNoiseStdDev) ||
      config.pressureNoiseStdDev < 0 ||
      !Number.isFinite(config.temperatureDrift)
    ) {
      throw new Error('Barometer noise and temperature drift configuration must be finite')
    }

    const requiredBufferSize = Math.max(
      2,
      Math.ceil((config.updateRate * config.latencyMs) / 1000) + 2
    )
    if (requiredBufferSize > MAX_BAROMETER_READING_BUFFER_SIZE) {
      throw new Error(
        `Barometer latency requires more than ${MAX_BAROMETER_READING_BUFFER_SIZE} buffered readings`
      )
    }

    this.config = { ...config }
    this.readingBufferSize = requiredBufferSize
    this.temperatureOffset = gaussianRandom(0, 2) // Random temperature offset
  }

  /**
   * Update the barometer simulation.
   *
   * The optional `dt` defaults to one configured sensor period for callers
   * that do not run a fixed-step simulation. Fixed-step callers should pass
   * their actual elapsed seconds so repeated calls between sensor ticks hold
   * the last output.
   */
  update(trueAltitude: number, dt: number = 1 / this.config.updateRate): BarometerReading {
    if (!Number.isFinite(trueAltitude)) {
      throw new Error('Barometer trueAltitude must be finite')
    }
    if (!Number.isFinite(dt) || dt < 0) {
      throw new Error('Barometer dt must be a non-negative finite number')
    }

    this.timeSinceLastReading += dt
    const samplePeriod = 1 / this.config.updateRate
    if (this.lastReading && this.timeSinceLastReading < samplePeriod) {
      return this.lastReading
    }
    this.timeSinceLastReading = this.lastReading ? this.timeSinceLastReading % samplePeriod : 0

    const now = performance.now()

    // Barometric formula: P = P0 * (1 - L*h/T0)^(g*M/(R*L))
    // Simplified: altitude = 44330 * (1 - (P/P0)^0.1903)
    const truePressure = this.baselinePressure * Math.pow(1 - trueAltitude / 44330, 5.255)

    // Add noise
    const noisyPressure = truePressure + gaussianRandom(0, this.config.pressureNoiseStdDev)
    const pressureAltitude = 44330 * (1 - Math.pow(noisyPressure / this.baselinePressure, 0.1903))

    // The configured coefficient is an altitude error per degree of sensor
    // temperature offset from the standard-atmosphere temperature at this
    // altitude. This keeps lapse rate and sensor drift as separate effects.
    const ambientTemperature = BAROMETER_REFERENCE_TEMPERATURE_C - 0.0065 * trueAltitude
    const sensorTemperature = ambientTemperature + this.temperatureOffset
    const temperatureAltitudeError =
      (sensorTemperature - ambientTemperature) * this.config.temperatureDrift

    const reading: BarometerReading = {
      timestamp: now,
      pressure: noisyPressure,
      altitude:
        pressureAltitude +
        temperatureAltitudeError +
        gaussianRandom(0, this.config.altitudeNoiseStdDev),
      temperature: sensorTemperature + gaussianRandom(0, 0.1),
    }

    this.readingBuffer.push(reading)
    if (this.readingBuffer.length > this.readingBufferSize) {
      this.readingBuffer.shift()
    }
    this.lastReading = reading
    return reading
  }

  /** Return the newest reading that has crossed the configured latency window. */
  getDelayedReading(): BarometerReading | null {
    return selectDelayedReading(this.readingBuffer, this.config.latencyMs)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA DISTORTION SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

export interface CameraDistortionConfig {
  // Radial distortion coefficients (Brown-Conrady model)
  k1: number // First radial distortion coefficient
  k2: number // Second radial distortion coefficient
  k3: number // Third radial distortion coefficient
  // Tangential distortion coefficients
  p1: number
  p2: number
  // Image noise
  noiseStdDev: number // 0-255 scale
  // Motion blur
  motionBlurStrength: number // 0-1
  // Vignetting
  vignetteStrength: number // 0-1
}

export const DEFAULT_CAMERA_DISTORTION: CameraDistortionConfig = {
  k1: -0.28, // Typical wide-angle lens
  k2: 0.07,
  k3: 0.0,
  p1: 0.0001,
  p2: -0.0001,
  noiseStdDev: 5,
  motionBlurStrength: 0.1,
  vignetteStrength: 0.3,
}

/**
 * Apply lens distortion to normalized image coordinates
 * Input/output in range [-1, 1] from image center
 */
export function applyLensDistortion(
  x: number,
  y: number,
  config: CameraDistortionConfig
): [number, number] {
  const r2 = x * x + y * y
  const r4 = r2 * r2
  const r6 = r4 * r2

  // Radial distortion
  const radialFactor = 1 + config.k1 * r2 + config.k2 * r4 + config.k3 * r6

  // Tangential distortion
  const tangentialX = 2 * config.p1 * x * y + config.p2 * (r2 + 2 * x * x)
  const tangentialY = config.p1 * (r2 + 2 * y * y) + 2 * config.p2 * x * y

  const distortedX = x * radialFactor + tangentialX
  const distortedY = y * radialFactor + tangentialY

  return [distortedX, distortedY]
}

/**
 * Apply camera effects to a canvas (noise, vignette)
 */
export function applyCameraEffects(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: CameraDistortionConfig
): void {
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  const centerX = width / 2
  const centerY = height / 2
  const maxDist = Math.sqrt(centerX * centerX + centerY * centerY)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4

      // Add noise
      const noise = gaussianRandom(0, config.noiseStdDev)
      data[idx] = Math.max(0, Math.min(255, data[idx] + noise))
      data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + noise))
      data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + noise))

      // Apply vignette
      if (config.vignetteStrength > 0) {
        const dx = x - centerX
        const dy = y - centerY
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist
        const vignette = 1 - config.vignetteStrength * dist * dist

        data[idx] = Math.round(data[idx] * vignette)
        data[idx + 1] = Math.round(data[idx + 1] * vignette)
        data[idx + 2] = Math.round(data[idx + 2] * vignette)
      }
    }
  }

  ctx.putImageData(imageData, 0, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED SENSOR SUITE
// ─────────────────────────────────────────────────────────────────────────────

export interface SensorSuiteConfig {
  imu: IMUConfig
  gps: GPSConfig
  barometer: BarometerConfig
  camera: CameraDistortionConfig
}

export class SensorSuite {
  public imu: IMUSensor
  public gps: GPSSensor
  public barometer: BarometerSensor
  public cameraConfig: CameraDistortionConfig

  constructor(config?: Partial<SensorSuiteConfig>) {
    this.imu = new IMUSensor(config?.imu)
    this.gps = new GPSSensor(config?.gps)
    this.barometer = new BarometerSensor(config?.barometer)
    this.cameraConfig = config?.camera || DEFAULT_CAMERA_DISTORTION
  }

  /** Update all sensors from drone state */
  update(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    acceleration: THREE.Vector3,
    orientation: THREE.Quaternion,
    angularVelocity: THREE.Vector3,
    dt: number
  ): {
    imu: IMUReading
    gps: GPSReading
    barometer: BarometerReading
  } {
    return {
      imu: this.imu.update(angularVelocity, acceleration, orientation, dt),
      gps: this.gps.update(position, velocity, dt),
      barometer: this.barometer.update(position.y, dt),
    }
  }
}

export default SensorSuite
