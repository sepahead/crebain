import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { BarometerSensor, DEFAULT_GPS_CONFIG, GPSSensor, IMUSensor } from '../SensorSimulation'

describe('SensorSimulation noise', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('produces finite readings even when Math.random returns 0', () => {
    // Math.random() can return exactly 0; Box-Muller must not turn that into
    // Math.log(0) = -Infinity injected into readings.
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const barometer = new BarometerSensor()
    const reading = barometer.update(100)

    expect(Number.isFinite(reading.pressure)).toBe(true)
    expect(Number.isFinite(reading.altitude)).toBe(true)
    expect(Number.isFinite(reading.temperature)).toBe(true)
  })

  it('keeps IMU bias random walks finite when Math.random returns 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const imu = new IMUSensor()
    const reading = imu.update(
      new THREE.Vector3(0.1, 0.2, 0.3),
      new THREE.Vector3(0, -9.81, 0),
      new THREE.Quaternion(),
      0.005
    )

    expect(Number.isFinite(reading.angularVelocity.x)).toBe(true)
    expect(Number.isFinite(reading.angularVelocity.y)).toBe(true)
    expect(Number.isFinite(reading.angularVelocity.z)).toBe(true)
    expect(Number.isFinite(reading.linearAcceleration.x)).toBe(true)
    expect(Number.isFinite(reading.linearAcceleration.y)).toBe(true)
    expect(Number.isFinite(reading.linearAcceleration.z)).toBe(true)
  })
})

describe('SensorSimulation update rate and latency', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('generates GPS readings at the configured update rate, not the caller rate', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const gps = new GPSSensor({ ...DEFAULT_GPS_CONFIG, dropoutProbability: 0 })

    // Caller at 60Hz for one second; a 5Hz GPS must emit ~5 distinct readings.
    const timestamps = new Set<number>()
    const dt = 1 / 60
    for (let i = 0; i < 60; i++) {
      now = (i * 1000) / 60
      const reading = gps.update(new THREE.Vector3(i, 0, 0), new THREE.Vector3(1, 0, 0), dt)
      timestamps.add(reading.timestamp)
    }

    expect(timestamps.size).toBeGreaterThanOrEqual(4)
    expect(timestamps.size).toBeLessThanOrEqual(6)
  })

  it('returns the cached IMU reading between sensor ticks', () => {
    const imu = new IMUSensor() // 200Hz -> 5ms period
    const angularVelocity = new THREE.Vector3(0.1, 0.2, 0.3)
    const acceleration = new THREE.Vector3(0, -9.81, 0)
    const orientation = new THREE.Quaternion()

    // Caller at 1kHz: only every 5th call may produce a new reading.
    const first = imu.update(angularVelocity, acceleration, orientation, 0.001)
    const second = imu.update(angularVelocity, acceleration, orientation, 0.001)
    expect(second).toBe(first)

    let latest = second
    for (let i = 0; i < 4; i++) {
      latest = imu.update(angularVelocity, acceleration, orientation, 0.001)
    }
    expect(latest).not.toBe(first)
  })

  it('delays GPS readings by latencyMs in wall-clock time', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const gps = new GPSSensor({ ...DEFAULT_GPS_CONFIG, dropoutProbability: 0 })

    // Run for 2 simulated seconds at a 60Hz caller rate.
    const dt = 1 / 60
    for (let i = 0; i <= 120; i++) {
      now = (i * 1000) / 60
      gps.update(new THREE.Vector3(i, 0, 0), new THREE.Vector3(1, 0, 0), dt)
    }

    const delayed = gps.getDelayedReading()
    expect(delayed).not.toBeNull()
    const age = now - delayed!.timestamp
    expect(age).toBeGreaterThanOrEqual(DEFAULT_GPS_CONFIG.latencyMs)
    // Newest reading that is old enough: at most one GPS period older than
    // the requested latency (5Hz -> 200ms period).
    expect(age).toBeLessThanOrEqual(
      DEFAULT_GPS_CONFIG.latencyMs + 1000 / DEFAULT_GPS_CONFIG.updateRate
    )
  })

  it('returns null from getDelayedReading until a reading is old enough', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const gps = new GPSSensor({ ...DEFAULT_GPS_CONFIG, dropoutProbability: 0 })

    gps.update(new THREE.Vector3(), new THREE.Vector3(), 1 / 60)
    expect(gps.getDelayedReading()).toBeNull()

    now = DEFAULT_GPS_CONFIG.latencyMs + 1
    expect(gps.getDelayedReading()).not.toBeNull()
  })
})
