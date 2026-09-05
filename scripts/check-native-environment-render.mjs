import assert from 'node:assert/strict'
import { ChildProcess, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OwnedGraphicsProcess } from './lib/owned-graphics-process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = process.argv[2]
if (!output || process.argv.length !== 3)
  throw new Error('Usage: node scripts/check-native-environment-render.mjs NEW_OUTPUT_DIRECTORY')
await mkdir(output, { recursive: false })
const save = (name, value) =>
  writeFile(resolve(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const sha = (value) => createHash('sha256').update(value).digest('hex')
async function files(directory) {
  const paths = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) paths.push(...(await files(resolve(directory, item.name))))
    else if (item.isFile()) paths.push(resolve(directory, item.name))
  }
  return paths
}
const paths = [
  ...(await files(resolve(root, 'src'))),
  ...(await files(resolve(root, 'scripts/lib'))),
  resolve(root, 'scripts/check-native-environment-render.mjs'),
  resolve(root, 'package.json'),
  resolve(root, 'bun.lock'),
].sort()
const sourceRoster = []
for (const path of paths) {
  const bytes = await readFile(path)
  sourceRoster.push({ path: relative(root, path), size: bytes.length, sha256: sha(bytes) })
}
const sourceIdentity = sha(JSON.stringify(sourceRoster))
const scene = JSON.parse(
  await readFile(resolve(root, 'fixtures/environments/city-block-v1/scene.json'), 'utf8')
)
for (const row of scene.rgbCameras) {
  row.width = 160
  row.height = 120
}
// A selected close view complements the city-wide camera, without changing world geometry.
for (const row of [scene.rgbCameras[0], scene.thermalCameras[0]]) {
  row.position = [0, 9, 5]
  row.target = [0, 8, 0]
}
const base = {
  profile: 'crebain.owned-city-graphics.v1',
  sourceIdentity,
  scene,
  droneIds: ['drone-a'],
  thermal: {
    profile: 'crebain.lumped-gray-thermal.v1',
    ambientK: 293.15,
    initialK: 293.15,
    capacityJPerK: 100,
    areaM2: 0.1,
    convectionWPerM2K: 10,
    emissivity: 0.9,
    motorEfficiency: 0.7,
  },
}
const roster = [
  'actual-render-and-repeat',
  'pose-and-temperature',
  'gaussian-ablation',
  'camera-order',
  'cold-context',
  'thermal-occlusion',
  'thirty-two-drones',
  'two-hundred-fifty-six-drones',
  'invalid-binding',
  'paused-browser-watchdog',
  'publication-retirement',
  'paused-setup-worker',
  'long-static-collection-with-moving-drone',
]
await save('input-commitment.json', {
  profile: 'crebain.selected-render-controls.v1',
  sourceIdentity,
  sourceRoster,
  roster,
  base,
  selection: 'Fixed engineering controls, not a random sample or throughput qualification',
  runtimeInputAuthority:
    'Renderer input values are test-owned references, not sensor-derived labels',
  exclusion:
    'No captured third-party assets; no external detection, native fusion, or NCP execution',
})
const results = []
let baseline
const decode = (row) => Buffer.from(row.bytesBase64, 'base64')
const vectors = (frame) => ({
  rgb: frame.rgb.map((row) => row.bytesBase64),
  thermal: frame.thermal.map((row) => row.bytesBase64),
})
function input(owner, plan, tick = 0) {
  return {
    planSha256: owner.diagnostics().planSha256,
    tick,
    drones: plan.droneIds.map((id, index) => ({
      id,
      position: [(index % 8) - 3.5, 8 + Math.floor(index / 64), Math.floor(index / 8) * 0.8],
      orientation: [0, 0, 0, 1],
      temperatureK: 400,
    })),
  }
}
async function withOwner(plan, run, timeoutMs = 30000) {
  const owner = await OwnedGraphicsProcess.prepare(JSON.stringify(plan), { timeoutMs })
  try {
    return await run(owner)
  } finally {
    await owner.retire()
  }
}
async function run(name, control) {
  const started = performance.now()
  try {
    const detail = await control()
    results.push({ name, status: 'passed', elapsedMs: performance.now() - started, detail })
  } catch (error) {
    results.push({
      name,
      status: 'failed',
      elapsedMs: performance.now() - started,
      error: String(error),
      stack: error.stack,
    })
  }
  await save(`${name}.json`, results.at(-1))
  console.log(`${name}: ${results.at(-1).status}`)
}

await run(roster[0], () =>
  withOwner(base, async (owner) => {
    const request = input(owner, base)
    request.drones[0].position = [0, 8, 0]
    baseline = await owner.capture(JSON.stringify(request))
    assert.match(owner.diagnostics().graphics.renderer, /Metal Renderer: Apple/)
    assert.equal(baseline.rgb.length, 2)
    assert.equal(baseline.thermal.length, 1)
    const heat = decode(baseline.thermal[0])
    const samples = Array.from({ length: heat.length / 4 }, (_, index) =>
      heat.readFloatLE(index * 4)
    )
    const ambient = (5.670374419e-8 * 293.15 ** 4) / Math.PI
    const hot = (5.670374419e-8 * (0.9 * 400 ** 4 + 0.1 * 293.15 ** 4)) / Math.PI
    assert(samples.some((sample) => Math.abs(sample - hot) < 1e-4))
    assert(samples.some((sample) => Math.abs(sample - ambient) < 1e-4))
    const repeated = await owner.capture(JSON.stringify(request))
    assert.deepEqual(vectors(repeated), vectors(baseline))
    await save('actual-baseline-frames.json', baseline)
    return {
      diagnostics: owner.diagnostics(),
      sampleCount: samples.length,
      hotPixelCount: samples.filter((sample) => Math.abs(sample - hot) < 1e-4).length,
      rgbSha256: baseline.rgb.map((row) => sha(decode(row))),
      thermalSha256: baseline.thermal.map((row) => sha(decode(row))),
    }
  })
)
await run(roster[1], () =>
  withOwner(base, async (owner) => {
    const request = input(owner, base)
    request.drones[0].position = [0, 8, 0]
    const start = await owner.capture(JSON.stringify(request))
    request.drones[0].temperatureK = 300
    const cold = await owner.capture(JSON.stringify(request))
    assert.deepEqual(cold.rgb, start.rgb)
    assert.notDeepEqual(cold.thermal, start.thermal)
    request.tick = 120
    request.drones[0].position = [1, 8, 0]
    const moved = await owner.capture(JSON.stringify(request))
    assert.notEqual(moved.rgb[0].bytesBase64, cold.rgb[0].bytesBase64)
    request.tick = 0
    request.drones[0].position = [0, 8, 0]
    request.drones[0].temperatureK = 400
    const restored = await owner.capture(JSON.stringify(request))
    assert.deepEqual(vectors(restored), vectors(start))
    assert.equal(start.rgb[0].bytesBase64, baseline.rgb[0].bytesBase64)
    return {
      restoredInputPixelsExact: true,
      temperatureOnlyRgbExact: true,
      changedPosePixelsDiffer: true,
    }
  })
)
await run(roster[2], async () => {
  const plan = structuredClone(base)
  plan.scene.materials.forEach((row) => (row.gaussianOpacity = 0))
  return withOwner(plan, async (owner) => {
    const request = input(owner, plan)
    request.drones[0].position = [0, 8, 0]
    const frames = await owner.capture(JSON.stringify(request))
    assert.notEqual(frames.rgb[1].bytesBase64, baseline.rgb[1].bytesBase64)
    assert.deepEqual(frames.thermal, baseline.thermal)
    await save('actual-no-gaussian-frames.json', frames)
    return { retainedMeshAndColliderGeometry: true, changedRgb: true, exactThermal: true }
  })
})
await run(roster[3], async () => {
  const plan = structuredClone(base)
  const [a, b] = plan.scene.rgbCameras
  plan.scene.rgbCameras = [
    { ...b, id: a.id },
    { ...a, id: b.id },
  ]
  return withOwner(plan, async (owner) => {
    const request = input(owner, plan)
    request.drones[0].position = [0, 8, 0]
    const frames = await owner.capture(JSON.stringify(request))
    assert.equal(frames.rgb[0].bytesBase64, baseline.rgb[1].bytesBase64)
    assert.equal(frames.rgb[1].bytesBase64, baseline.rgb[0].bytesBase64)
    return { oppositeCameraOrderExact: true }
  })
})
await run(roster[4], () =>
  withOwner(base, async (owner) => {
    const request = input(owner, base)
    request.drones[0].position = [0, 8, 0]
    const frames = await owner.capture(JSON.stringify(request))
    assert.deepEqual(vectors(frames), vectors(baseline))
    assert.notEqual(frames.generation, baseline.generation)
    return { freshProcessPixelsExact: true }
  })
)
await run(roster[5], async () => {
  const plan = structuredClone(base)
  plan.scene.solids = [
    {
      shape: {
        id: 'occluder',
        center: [0, 8.5, 2.5],
        halfExtents: [2, 2, 0.2],
        yaw: 0,
        friction: 0.5,
        restitution: 0,
      },
      materialId: 'concrete',
    },
  ]
  return withOwner(plan, async (owner) => {
    const request = input(owner, plan)
    request.drones[0].position = [0, 8, 0]
    const frames = await owner.capture(JSON.stringify(request))
    const bytes = decode(frames.thermal[0])
    const ambient = (5.670374419e-8 * 293.15 ** 4) / Math.PI
    for (let offset = 0; offset < bytes.length; offset += 4)
      assert(Math.abs(bytes.readFloatLE(offset) - ambient) < 1e-4)
    return { hotSurfaceOccluded: true, rawPixelCount: bytes.length / 4 }
  })
})
for (const [name, count] of [
  [roster[6], 32],
  [roster[7], 256],
])
  await run(name, async () => {
    const plan = structuredClone(base)
    plan.droneIds = Array.from(
      { length: count },
      (_, index) => `drone-${String(index).padStart(3, '0')}`
    )
    return withOwner(plan, async (owner) => {
      const first = await owner.capture(JSON.stringify(input(owner, plan)))
      const again = await owner.capture(JSON.stringify(input(owner, plan)))
      assert.deepEqual(vectors(first), vectors(again))
      return {
        count,
        completeFrames: first.rgb.length + first.thermal.length,
        bytes: [...first.rgb, ...first.thermal].reduce((sum, row) => sum + decode(row).length, 0),
        diagnostics: owner.diagnostics(),
      }
    })
  })
await run(roster[8], () =>
  withOwner(base, async (owner) => {
    const request = input(owner, base)
    request.planSha256 = '0'.repeat(64)
    await assert.rejects(owner.capture(JSON.stringify(request)))
    await assert.rejects(owner.capture(JSON.stringify(input(owner, base))), /retired/)
    return { invalidBindingRetired: true }
  })
)
await run(roster[9], () =>
  withOwner(
    base,
    async (owner) => {
      const { pid } = owner.diagnostics()
      process.kill(-pid, 'SIGSTOP')
      await assert.rejects(owner.capture(JSON.stringify(input(owner, base))))
      await assert.rejects(owner.capture(JSON.stringify(input(owner, base))), /retired/)
      return { pausedOwnedBrowserKilled: true }
    },
    2000
  )
)
await run(roster[10], () =>
  withOwner(base, async (owner) => {
    const original = ChildProcess.prototype.emit
    let retirement
    ChildProcess.prototype.emit = function (event, ...arguments_) {
      const value = original.call(this, event, ...arguments_)
      if (
        this.pid === owner.diagnostics().workerPid &&
        event === 'message' &&
        arguments_[0]?.kind === 'result' &&
        arguments_[0]?.sequence === 2
      )
        queueMicrotask(() => {
          retirement = owner.retire()
        })
      return value
    }
    try {
      await assert.rejects(owner.capture(JSON.stringify(input(owner, base))), /retired.*publish/i)
      await retirement
      return { retiredBetweenPrivateResolutionAndPublicContinuation: true }
    } finally {
      ChildProcess.prototype.emit = original
    }
  })
)
await run(roster[11], async () => {
  const original = ChildProcess.prototype.emit
  let stoppedPid
  ChildProcess.prototype.emit = function (event, ...arguments_) {
    const value = original.call(this, event, ...arguments_)
    if (
      event === 'spawn' &&
      this.spawnargs.includes(
        fileURLToPath(new URL('./lib/owned-graphics-worker.mjs', import.meta.url))
      )
    ) {
      stoppedPid = this.pid
      process.kill(this.pid, 'SIGSTOP')
    }
    return value
  }
  try {
    await assert.rejects(
      OwnedGraphicsProcess.prepare(JSON.stringify(base), { timeoutMs: 100 }),
      /cleanup unresolved/
    )
    assert(stoppedPid)
    assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' })
    return { stoppedWorkerKilled: true, absentBrowserAnnouncementKeptUnresolved: true }
  } finally {
    ChildProcess.prototype.emit = original
  }
})
await run(roster[12], () =>
  withOwner(base, async (owner) => {
    const request = input(owner, base)
    request.drones[0].position = [0, 8, 0]
    const first = await owner.capture(JSON.stringify(request))
    const changes = new Set()
    for (let frame = 1; frame <= 120; frame++) {
      request.tick = frame * 12
      request.drones[0].position = [Math.sin(frame / 9), 8, 0]
      request.drones[0].temperatureK = 300 + (frame % 50)
      const current = await owner.capture(JSON.stringify(request))
      changes.add(sha(decode(current.rgb[0])))
    }
    request.tick = 0
    request.drones[0].position = [0, 8, 0]
    request.drones[0].temperatureK = 400
    const restored = await owner.capture(JSON.stringify(request))
    assert.deepEqual(vectors(restored), vectors(first))
    assert(changes.size > 60)
    return { captures: 122, distinctMovingRgbFrames: changes.size, exactReturnedPixels: true }
  })
)
const sourceDrift = []
for (const row of sourceRoster)
  if (sha(await readFile(resolve(root, row.path))) !== row.sha256) sourceDrift.push(row.path)
const report = {
  sourceIdentity,
  sourceDrift,
  scope: 'Selected actual component controls; no installed or throughput qualification',
  results,
  passed: results.filter((row) => row.status === 'passed').length,
  failed: results.filter((row) => row.status !== 'passed').length,
}
await save('report.json', report)
if (report.failed || sourceDrift.length) process.exitCode = 1
