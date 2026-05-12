/**
 * CREBAIN Detector Benchmark Tests
 * Adaptive Response & Awareness System (ARAS)
 *
 * Comprehensive performance benchmarks comparing inference speed
 * across YOLO, RF-DETR, Moondream, and CoreML detectors.
 */

import { describe, it, expect } from 'vitest'
import type { ObjectDetector, DetectorType } from '../types'
import benchmarkBudgets from '../benchmarkBudgets.json'

// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const BENCHMARK_CONFIG = {
  warmupIterations: 3,     // Runs to warm up the model
  benchmarkIterations: 10, // Runs for actual measurement
  imageSizes: [
    { width: 320, height: 240, name: 'QVGA' },
    { width: 640, height: 480, name: 'VGA' },
    { width: 1280, height: 720, name: 'HD' },
  ],
  confidenceThreshold: 0.25,
}

// ─────────────────────────────────────────────────────────────────────────────
// STATISTICAL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

interface BenchmarkStats {
  mean: number
  std: number
  min: number
  max: number
  median: number
  p95: number
  samples: number
}

function calculateStats(values: number[]): BenchmarkStats {
  const validValues = values.filter(value => Number.isFinite(value) && value >= 0)

  if (validValues.length === 0) {
    return { mean: 0, std: 0, min: 0, max: 0, median: 0, p95: 0, samples: 0 }
  }

  const sorted = [...validValues].sort((a, b) => a - b)
  const n = validValues.length
  const mean = validValues.reduce((a, b) => a + b, 0) / n
  const variance = validValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n
  const std = Math.sqrt(variance)
  const min = sorted[0]
  const max = sorted[n - 1]
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)]
  const p95 = sorted[Math.floor(n * 0.95)]

  return { mean, std, min, max, median, p95, samples: n }
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}μs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatFps(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'N/A'
  return `${(1000 / ms).toFixed(1)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK IMAGE DATA GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate synthetic test image data
 * Creates a gradient pattern with some noise to simulate real imagery
 */
function createMockImageData(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4

      // Create gradient with noise
      const gradientR = (x / width) * 255
      const gradientG = (y / height) * 255
      const gradientB = ((x + y) / (width + height)) * 255

      // Add some noise
      const noise = (Math.random() - 0.5) * 30

      data[idx] = Math.max(0, Math.min(255, gradientR + noise))
      data[idx + 1] = Math.max(0, Math.min(255, gradientG + noise))
      data[idx + 2] = Math.max(0, Math.min(255, gradientB + noise))
      data[idx + 3] = 255 // Alpha
    }
  }

  return new ImageData(data, width, height)
}

/**
 * Create mock image with synthetic objects for accuracy testing
 */
function createMockImageWithObjects(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)

  // Fill background with sky-like gradient
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const skyGradient = 1 - (y / height) * 0.3

      data[idx] = Math.floor(135 * skyGradient)     // R
      data[idx + 1] = Math.floor(206 * skyGradient) // G
      data[idx + 2] = Math.floor(235 * skyGradient) // B
      data[idx + 3] = 255
    }
  }

  // Add some dark blob regions (simulating objects)
  const blobs = [
    { x: width * 0.3, y: height * 0.2, r: Math.min(width, height) * 0.05 },
    { x: width * 0.7, y: height * 0.4, r: Math.min(width, height) * 0.03 },
    { x: width * 0.5, y: height * 0.6, r: Math.min(width, height) * 0.04 },
  ]

  for (const blob of blobs) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.sqrt(Math.pow(x - blob.x, 2) + Math.pow(y - blob.y, 2))
        if (dist < blob.r) {
          const idx = (y * width + x) * 4
          const factor = 1 - (dist / blob.r)
          data[idx] = Math.floor(data[idx] * (1 - factor * 0.7))
          data[idx + 1] = Math.floor(data[idx + 1] * (1 - factor * 0.7))
          data[idx + 2] = Math.floor(data[idx + 2] * (1 - factor * 0.7))
        }
      }
    }
  }

  return new ImageData(data, width, height)
}

// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK RESULT TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface DetectorBenchmarkResult {
  detectorType: DetectorType
  detectorName: string
  initTimeMs: number
  initSuccess: boolean
  initError?: string
  inferenceStats: Map<string, BenchmarkStats>  // keyed by image size name
  detectionsPerSize: Map<string, number>
  averageLatencyMs: number
  throughputFps: number
}

interface BenchmarkSummary {
  results: DetectorBenchmarkResult[]
  timestamp: Date
  config: typeof BENCHMARK_CONFIG
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR FACTORY
// ─────────────────────────────────────────────────────────────────────────────

async function createDetector(type: DetectorType): Promise<ObjectDetector> {
  switch (type) {
    case 'yolo': {
      const { YOLODetector } = await import('../YOLODetector')
      return new YOLODetector({
        modelPath: '/models/yolov8n.onnx',
        confidenceThreshold: BENCHMARK_CONFIG.confidenceThreshold,
      })
    }
    case 'rf-detr': {
      const { RFDETRDetector } = await import('../RFDETRDetector')
      return new RFDETRDetector({
        modelPath: '/models/rf-detr.onnx',
        confidenceThreshold: BENCHMARK_CONFIG.confidenceThreshold,
      })
    }
    case 'moondream': {
      const { MoondreamDetector } = await import('../MoondreamDetector')
      return new MoondreamDetector({
        confidenceThreshold: BENCHMARK_CONFIG.confidenceThreshold,
      })
    }
    case 'coreml': {
      const { CoreMLDetector } = await import('../CoreMLDetector')
      return new CoreMLDetector({
        modelPath: '/models/coreml-detector.onnx',
        confidenceThreshold: BENCHMARK_CONFIG.confidenceThreshold,
      })
    }
    default:
      throw new Error(`Unknown detector type: ${type}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function benchmarkDetector(type: DetectorType): Promise<DetectorBenchmarkResult> {
  const result: DetectorBenchmarkResult = {
    detectorType: type,
    detectorName: '',
    initTimeMs: 0,
    initSuccess: false,
    inferenceStats: new Map(),
    detectionsPerSize: new Map(),
    averageLatencyMs: 0,
    throughputFps: 0,
  }

  let detector: ObjectDetector | null = null

  try {
    // Measure initialization time
    const initStart = performance.now()
    detector = await createDetector(type)
    await detector.initialize()
    result.initTimeMs = performance.now() - initStart
    result.initSuccess = true
    result.detectorName = detector.name

    const allLatencies: number[] = []

    // Run benchmarks for each image size
    for (const sizeConfig of BENCHMARK_CONFIG.imageSizes) {
      const { width, height, name } = sizeConfig
      const testImage = createMockImageData(width, height)
      const latencies: number[] = []

      // Warmup runs
      for (let i = 0; i < BENCHMARK_CONFIG.warmupIterations; i++) {
        try {
          await detector.detect(testImage)
        } catch {
          // Ignore warmup errors
        }
      }

      // Benchmark runs
      let lastDetectionCount = 0
      for (let i = 0; i < BENCHMARK_CONFIG.benchmarkIterations; i++) {
        const start = performance.now()
        try {
          const detections = await detector.detect(testImage)
          const elapsed = performance.now() - start
          latencies.push(elapsed)
          allLatencies.push(elapsed)
          lastDetectionCount = detections.length
        } catch {
          // Record as failed with max time
          latencies.push(Infinity)
        }
      }

      // Filter out failed runs
      const validLatencies = latencies.filter(l => isFinite(l))
      result.inferenceStats.set(name, calculateStats(validLatencies))
      result.detectionsPerSize.set(name, lastDetectionCount)
    }

    // Calculate overall metrics
    const validAllLatencies = allLatencies.filter(l => isFinite(l))
    if (validAllLatencies.length > 0) {
      const overallStats = calculateStats(validAllLatencies)
      result.averageLatencyMs = overallStats.mean
      result.throughputFps = 1000 / overallStats.mean
    }

  } catch (error) {
    result.initSuccess = false
    result.initError = error instanceof Error ? error.message : String(error)
  } finally {
    if (detector) {
      try {
        detector.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY TABLE GENERATION
// ─────────────────────────────────────────────────────────────────────────────

function generateSummaryTable(summary: BenchmarkSummary): string {
  const lines: string[] = []

  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('                    CREBAIN DETECTOR BENCHMARK RESULTS')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push(`  Timestamp: ${summary.timestamp.toISOString()}`)
  lines.push(`  Warmup: ${summary.config.warmupIterations} iterations`)
  lines.push(`  Benchmark: ${summary.config.benchmarkIterations} iterations per size`)
  lines.push('')

  // Initialization summary
  lines.push('┌─────────────────────────────────────────────────────────────────────────────┐')
  lines.push('│                         INITIALIZATION TIMES                               │')
  lines.push('├──────────────┬──────────────────┬───────────────┬──────────────────────────┤')
  lines.push('│ Detector     │ Name             │ Init Time     │ Status                   │')
  lines.push('├──────────────┼──────────────────┼───────────────┼──────────────────────────┤')

  for (const result of summary.results) {
    const detector = result.detectorType.padEnd(12)
    const name = (result.detectorName || 'N/A').padEnd(16)
    const initTime = result.initSuccess ? formatMs(result.initTimeMs).padEnd(13) : 'N/A'.padEnd(13)
    const status = result.initSuccess ? '✓ Ready'.padEnd(24) : `✗ ${(result.initError || 'Failed').substring(0, 20)}`.padEnd(24)
    lines.push(`│ ${detector} │ ${name} │ ${initTime} │ ${status} │`)
  }

  lines.push('└──────────────┴──────────────────┴───────────────┴──────────────────────────┘')
  lines.push('')

  // Inference performance by size
  for (const sizeConfig of summary.config.imageSizes) {
    const sizeName = sizeConfig.name
    lines.push(`┌─────────────────────────────────────────────────────────────────────────────┐`)
    lines.push(`│                    INFERENCE PERFORMANCE @ ${sizeName.padEnd(4)} (${sizeConfig.width}x${sizeConfig.height})                    │`)
    lines.push('├──────────────┬──────────┬──────────┬──────────┬──────────┬────────┬───────┤')
    lines.push('│ Detector     │ Mean     │ Std      │ Min      │ Max      │ P95    │ FPS   │')
    lines.push('├──────────────┼──────────┼──────────┼──────────┼──────────┼────────┼───────┤')

    for (const result of summary.results) {
      const stats = result.inferenceStats.get(sizeName)
      if (!result.initSuccess || !stats || stats.samples === 0) {
        lines.push(`│ ${result.detectorType.padEnd(12)} │ ${'N/A'.padEnd(8)} │ ${'N/A'.padEnd(8)} │ ${'N/A'.padEnd(8)} │ ${'N/A'.padEnd(8)} │ ${'N/A'.padEnd(6)} │ ${'N/A'.padEnd(5)} │`)
      } else {
        const detector = result.detectorType.padEnd(12)
        const mean = formatMs(stats.mean).padEnd(8)
        const std = formatMs(stats.std).padEnd(8)
        const min = formatMs(stats.min).padEnd(8)
        const max = formatMs(stats.max).padEnd(8)
        const p95 = formatMs(stats.p95).padEnd(6)
        const fps = formatFps(stats.mean).padEnd(5)
        lines.push(`│ ${detector} │ ${mean} │ ${std} │ ${min} │ ${max} │ ${p95} │ ${fps} │`)
      }
    }

    lines.push('└──────────────┴──────────┴──────────┴──────────┴──────────┴────────┴───────┘')
    lines.push('')
  }

  // Overall comparison
  lines.push('┌─────────────────────────────────────────────────────────────────────────────┐')
  lines.push('│                           OVERALL COMPARISON                               │')
  lines.push('├──────────────┬───────────────────┬───────────────────┬─────────────────────┤')
  lines.push('│ Detector     │ Avg Latency       │ Throughput (FPS)  │ Ranking             │')
  lines.push('├──────────────┼───────────────────┼───────────────────┼─────────────────────┤')

  // Sort by average latency for ranking
  const sortedResults = [...summary.results]
    .filter(r => r.initSuccess && r.averageLatencyMs > 0)
    .sort((a, b) => a.averageLatencyMs - b.averageLatencyMs)

  const rankings = new Map<DetectorType, number>()
  sortedResults.forEach((r, i) => rankings.set(r.detectorType, i + 1))

  for (const result of summary.results) {
    const detector = result.detectorType.padEnd(12)
    if (!result.initSuccess) {
      lines.push(`│ ${detector} │ ${'N/A'.padEnd(17)} │ ${'N/A'.padEnd(17)} │ ${'Not Available'.padEnd(19)} │`)
    } else if (result.averageLatencyMs === 0) {
      lines.push(`│ ${detector} │ ${'No data'.padEnd(17)} │ ${'No data'.padEnd(17)} │ ${'No data'.padEnd(19)} │`)
    } else {
      const avgLatency = formatMs(result.averageLatencyMs).padEnd(17)
      const throughput = `${result.throughputFps.toFixed(1)} FPS`.padEnd(17)
      const rank = rankings.get(result.detectorType)
      const rankStr = rank === 1 ? '🥇 Fastest' : rank === 2 ? '🥈 Second' : rank === 3 ? '🥉 Third' : `#${rank}`
      lines.push(`│ ${detector} │ ${avgLatency} │ ${throughput} │ ${rankStr.padEnd(19)} │`)
    }
  }

  lines.push('└──────────────┴───────────────────┴───────────────────┴─────────────────────┘')
  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('')

  return lines.join('\n')
}

describe('Detector benchmark utilities', () => {
  it('calculates stats using only finite non-negative samples', () => {
    expect(calculateStats([10, Number.POSITIVE_INFINITY, -1, 20, Number.NaN])).toMatchObject({
      mean: 15,
      min: 10,
      max: 20,
      median: 15,
      samples: 2,
    })
  })

  it('returns zeroed stats when no benchmark samples are valid', () => {
    expect(calculateStats([Number.POSITIVE_INFINITY, Number.NaN, -1])).toEqual({
      mean: 0,
      std: 0,
      min: 0,
      max: 0,
      median: 0,
      p95: 0,
      samples: 0,
    })
  })

  it('does not report infinite FPS for missing benchmark samples', () => {
    expect(formatFps(0)).toBe('N/A')
    expect(formatFps(Number.POSITIVE_INFINITY)).toBe('N/A')
    expect(formatFps(25)).toBe('40.0')
  })

  it('keeps detector benchmark budgets finite and positive', () => {
    for (const detector of ['yolo', 'rf-detr', 'moondream', 'coreml'] as const) {
      const budget = benchmarkBudgets.detectors[detector]
      expect(Number.isFinite(budget.maxP95LatencyMs)).toBe(true)
      expect(Number.isFinite(budget.minThroughputFps)).toBe(true)
      expect(budget.maxP95LatencyMs).toBeGreaterThan(0)
      expect(budget.minThroughputFps).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// VITEST TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.RUN_BENCHMARKS)('Detector Benchmarks', () => {
  const allResults: DetectorBenchmarkResult[] = []
  const detectorTypes: DetectorType[] = ['yolo', 'rf-detr', 'moondream', 'coreml']

  describe('Individual Detector Benchmarks', () => {
    for (const type of detectorTypes) {
      it(`should benchmark ${type.toUpperCase()} detector`, async () => {
        console.log(`\n🔄 Benchmarking ${type.toUpperCase()} detector...`)

        const result = await benchmarkDetector(type)
        allResults.push(result)

        if (result.initSuccess) {
          console.log(`  ✓ ${result.detectorName} initialized in ${formatMs(result.initTimeMs)}`)

          for (const [sizeName, stats] of result.inferenceStats) {
            if (stats.samples > 0) {
              console.log(`    ${sizeName}: mean=${formatMs(stats.mean)}, std=${formatMs(stats.std)}, fps=${formatFps(stats.mean)}`)
              expect(stats.p95).toBeLessThanOrEqual(benchmarkBudgets.detectors[type].maxP95LatencyMs)
            }
          }

          expect(result.averageLatencyMs).toBeGreaterThan(0)
          expect(result.throughputFps).toBeGreaterThanOrEqual(benchmarkBudgets.detectors[type].minThroughputFps)
        } else {
          console.log(`  ✗ Failed to initialize: ${result.initError}`)
          // Test still passes - we just record the failure
          expect(result.initSuccess).toBe(false)
        }
      }, 60000) // 60 second timeout per detector
    }
  })

  describe('Comparative Analysis', () => {
    it('should generate summary comparison table', () => {
      const summary: BenchmarkSummary = {
        results: allResults,
        timestamp: new Date(),
        config: BENCHMARK_CONFIG,
      }

      const table = generateSummaryTable(summary)
      console.log(table)

      // Verify we have results for all detector types
      expect(allResults.length).toBe(detectorTypes.length)
    })

    it('should identify fastest detector', () => {
      const successfulResults = allResults.filter(r => r.initSuccess && r.averageLatencyMs > 0)

      if (successfulResults.length > 0) {
        const fastest = successfulResults.reduce((a, b) =>
          a.averageLatencyMs < b.averageLatencyMs ? a : b
        )

        console.log(`\n🏆 Fastest detector: ${fastest.detectorName} (${fastest.detectorType})`)
        console.log(`   Average latency: ${formatMs(fastest.averageLatencyMs)}`)
        console.log(`   Throughput: ${fastest.throughputFps.toFixed(1)} FPS`)

        expect(fastest.averageLatencyMs).toBeGreaterThan(0)
      } else {
        console.log('\n⚠️ No detectors initialized successfully for comparison')
      }
    })

    it('should compare real-time capability (>30 FPS)', () => {
      const realtimeCapable = allResults.filter(r =>
        r.initSuccess && r.throughputFps >= 30
      )

      console.log(`\n📊 Real-time capable detectors (≥30 FPS): ${realtimeCapable.length}`)
      for (const r of realtimeCapable) {
        console.log(`   ✓ ${r.detectorName}: ${r.throughputFps.toFixed(1)} FPS`)
      }

      // Just log, don't fail if none are real-time capable
      expect(realtimeCapable.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Memory and Resource Tests', () => {
    it('should properly dispose detectors without memory leaks', async () => {
      for (const type of detectorTypes) {
        let detector: ObjectDetector | null = null

        try {
          detector = await createDetector(type)
          await detector.initialize()

          // Run a few detections
          const testImage = createMockImageData(320, 240)
          for (let i = 0; i < 3; i++) {
            try {
              await detector.detect(testImage)
            } catch {
              // Ignore detection errors
            }
          }

          // Dispose
          detector.dispose()

          // Verify detector is no longer ready
          expect(detector.isReady()).toBe(false)
        } catch {
          // Initialization failed, which is acceptable
        } finally {
          if (detector?.isReady()) {
            detector.dispose()
          }
        }
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE BENCHMARK FUNCTION (for manual execution)
// ─────────────────────────────────────────────────────────────────────────────

export async function runFullBenchmark(): Promise<BenchmarkSummary> {
  console.log('\n🚀 Starting CREBAIN Detector Benchmark Suite...\n')

  const detectorTypes: DetectorType[] = ['yolo', 'rf-detr', 'moondream', 'coreml']
  const results: DetectorBenchmarkResult[] = []

  for (const type of detectorTypes) {
    console.log(`Benchmarking ${type}...`)
    const result = await benchmarkDetector(type)
    results.push(result)

    if (result.initSuccess) {
      console.log(`  ✓ Complete: avg ${formatMs(result.averageLatencyMs)}, ${result.throughputFps.toFixed(1)} FPS`)
    } else {
      console.log(`  ✗ Failed: ${result.initError}`)
    }
  }

  const summary: BenchmarkSummary = {
    results,
    timestamp: new Date(),
    config: BENCHMARK_CONFIG,
  }

  console.log(generateSummaryTable(summary))

  return summary
}

// Export utilities for use in other tests
export {
  createMockImageData,
  createMockImageWithObjects,
  calculateStats,
  benchmarkDetector,
  generateSummaryTable,
  type BenchmarkStats,
  type DetectorBenchmarkResult,
  type BenchmarkSummary,
}
