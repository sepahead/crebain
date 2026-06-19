import { describe, it, expect } from 'vitest'
import { getThreatLevel, mapToDetectionClass } from '../types'

// Mirror of the Rust `calculate_threat_level_matches_canonical_table` test in
// src-tauri/src/sensor_fusion.rs. The native and browser engines MUST assign the
// same threat level to the same raw label, so this exercises the full
// getThreatLevel(mapToDetectionClass(label), confidence) chain. Strict `>` at
// every threshold (0.8, 0.7, 0.5).
describe('threat-level canonical table (Rust↔TS parity)', () => {
  const threat = (label: string, conf: number) => getThreatLevel(mapToDetectionClass(label), conf)

  it('graduates drone threat by confidence', () => {
    expect(threat('drone', 0.9)).toBe(4)
    expect(threat('drone', 0.8)).toBe(3) // boundary, strict >
    expect(threat('drone', 0.6)).toBe(3)
    expect(threat('drone', 0.5)).toBe(2) // boundary
    expect(threat('drone', 0.3)).toBe(2)
  })

  it('maps drone aliases and demo remaps the same way as Rust', () => {
    expect(threat('DRONE', 0.9)).toBe(4) // case-insensitive
    expect(threat('uav', 0.9)).toBe(4)
    expect(threat('quadcopter', 0.9)).toBe(4)
    expect(threat('kite', 0.9)).toBe(4) // demo remap
  })

  it('treats aircraft/helicopter as guarded and bird as minimal', () => {
    expect(threat('aircraft', 0.99)).toBe(2)
    expect(threat('airplane', 0.99)).toBe(2)
    expect(threat('helicopter', 0.99)).toBe(2)
    expect(threat('bird', 0.9)).toBe(1)
    expect(threat('blackbird', 0.9)).toBe(1) // 'bird' substring
  })

  it('graduates unknown and buckets compound labels as unknown', () => {
    expect(threat('balloon', 0.8)).toBe(3)
    expect(threat('balloon', 0.7)).toBe(2) // boundary
    expect(threat('fpv-drone', 0.9)).toBe(3) // compound label → unknown (parity)
    expect(threat('', 0.9)).toBe(3)
    expect(threat('clutter', 0.5)).toBe(2)
  })
})
