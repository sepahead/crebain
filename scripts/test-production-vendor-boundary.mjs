#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PINNED_PRODUCTION_VENDORS,
  assertProductionVendorDependencyPins,
  assertRapierProductionOutput,
  assertSparkProductionOutput,
  assertSparkWorkerProductionSource,
  assertThreeCoreProductionOutput,
  assertThreeGltfProductionOutput,
  assertVendorPackageMetadata,
  extractSparkWorkerSource,
  productionVendorBoundaryPlugin,
  transformRapierProductionSource,
  transformSparkProductionSource,
  transformThreeCoreProductionSource,
  transformThreeGltfProductionSource,
  verifyPinnedProductionVendorInstallation,
} from './lib/production-vendor-boundary.mjs'
import { assertNoForbiddenRuntimeCapabilities } from './check-production-authority-boundary.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const sparkSpec = PINNED_PRODUCTION_VENDORS.spark
const rapierSpec = PINNED_PRODUCTION_VENDORS.rapier
const threeSpec = PINNED_PRODUCTION_VENDORS.three
const sparkSource = readFileSync(resolve(ROOT, sparkSpec.modulePath), 'utf8')
const rapierSource = readFileSync(resolve(ROOT, rapierSpec.modulePath), 'utf8')
const threeCoreSource = readFileSync(resolve(ROOT, threeSpec.coreModulePath), 'utf8')
const threeGltfSource = readFileSync(resolve(ROOT, threeSpec.gltfLoaderPath), 'utf8')
const rootPackageSource = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const lockSource = readFileSync(resolve(ROOT, 'bun.lock'), 'utf8')
const viteConfigSource = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8')

let negativeCases = 0

function expectFailure(action, expected, label) {
  let failure = null
  try {
    action()
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  assert(failure !== null, `${label}: invalid input was accepted`)
  assert(
    failure.includes(expected),
    `${label}: expected failure containing '${expected}', got '${failure}'`
  )
  negativeCases += 1
}

verifyPinnedProductionVendorInstallation(ROOT)
assertProductionVendorDependencyPins(rootPackageSource, lockSource)
assert.equal(
  viteConfigSource.match(/modulePreload:\s*\{\s*polyfill:\s*false\s*\}/g)?.length,
  1,
  'Vite modulepreload polyfill must be disabled exactly once'
)

const plugin = productionVendorBoundaryPlugin(ROOT)
assert.equal(plugin.name, 'crebain-production-vendor-boundary')
assert.equal(plugin.apply, 'build')
assert.equal(plugin.enforce, 'pre')
plugin.buildStart()
assert.equal(
  plugin.transform('export const untouched = true', resolve(ROOT, 'src/untouched.ts')),
  null
)

const sparkResult = plugin.transform(sparkSource, resolve(ROOT, sparkSpec.modulePath))
const rapierResult = plugin.transform(
  rapierSource,
  `${resolve(ROOT, rapierSpec.modulePath)}?v=0.19.3`
)
const threeCoreResult = plugin.transform(
  threeCoreSource,
  `${resolve(ROOT, threeSpec.coreModulePath)}?v=0.182.0`
)
const threeGltfResult = plugin.transform(threeGltfSource, resolve(ROOT, threeSpec.gltfLoaderPath))
assert.equal(typeof sparkResult?.code, 'string')
assert.equal(typeof rapierResult?.code, 'string')
assert.equal(typeof threeCoreResult?.code, 'string')
assert.equal(typeof threeGltfResult?.code, 'string')
assert.equal(sparkResult.map, null)
assert.equal(rapierResult.map, null)
assert.equal(threeCoreResult.map, null)
assert.equal(threeGltfResult.map, null)
plugin.buildEnd()

const sparkOutput = sparkResult.code
const rapierOutput = rapierResult.code
const threeCoreOutput = threeCoreResult.code
const threeGltfOutput = threeGltfResult.code
const sparkWorker = extractSparkWorkerSource(sparkOutput)

assertSparkProductionOutput(sparkOutput)
assertRapierProductionOutput(rapierOutput)
assertThreeCoreProductionOutput(threeCoreOutput)
assertThreeGltfProductionOutput(threeGltfOutput)
assertNoForbiddenRuntimeCapabilities('transformed-spark.js', sparkOutput, {
  allowVendorFunctionConstructors: true,
})
assertNoForbiddenRuntimeCapabilities('transformed-spark-worker.js', sparkWorker, {
  allowVendorFunctionConstructors: true,
})
assertNoForbiddenRuntimeCapabilities('transformed-rapier.js', rapierOutput, {
  allowVendorFunctionConstructors: true,
})
assertNoForbiddenRuntimeCapabilities('transformed-three-core.js', threeCoreOutput, {
  allowVendorFunctionConstructors: true,
})
assertNoForbiddenRuntimeCapabilities('transformed-three-gltf.js', threeGltfOutput, {
  allowVendorFunctionConstructors: true,
})

expectFailure(
  () => transformSparkProductionSource(`${sparkSource}\n`),
  'Spark module SHA-256',
  'Spark source mutation'
)
expectFailure(
  () => transformRapierProductionSource(`${rapierSource}\n`),
  'Rapier module SHA-256',
  'Rapier source mutation'
)
expectFailure(
  () => transformThreeCoreProductionSource(`${threeCoreSource}\n`),
  'Three core module SHA-256',
  'Three core source mutation'
)
expectFailure(
  () => transformThreeGltfProductionSource(`${threeGltfSource}\n`),
  'Three GLTFLoader module SHA-256',
  'Three GLTFLoader source mutation'
)

const sparkPackageSource = readFileSync(resolve(ROOT, sparkSpec.packagePath), 'utf8')
const rapierPackageSource = readFileSync(resolve(ROOT, rapierSpec.packagePath), 'utf8')
const threePackageSource = readFileSync(resolve(ROOT, threeSpec.packagePath), 'utf8')
expectFailure(
  () =>
    assertVendorPackageMetadata(
      sparkSpec,
      sparkPackageSource.replace('"version": "0.1.10"', '"version": "0.1.11"')
    ),
  'package.json SHA-256 drift',
  'Spark package mutation'
)
expectFailure(
  () =>
    assertVendorPackageMetadata(
      rapierSpec,
      rapierPackageSource.replace('"module": "rapier.mjs"', '"module": "other.mjs"')
    ),
  'package.json SHA-256 drift',
  'Rapier package mutation'
)
expectFailure(
  () =>
    assertVendorPackageMetadata(
      threeSpec,
      threePackageSource.replace('"version": "0.182.0"', '"version": "0.182.1"')
    ),
  'package.json SHA-256 drift',
  'Three package mutation'
)
expectFailure(
  () =>
    assertProductionVendorDependencyPins(
      rootPackageSource.replace('"@sparkjsdev/spark": "0.1.10"', '"@sparkjsdev/spark": "^0.1.10"'),
      lockSource
    ),
  'root package.json must pin @sparkjsdev/spark exactly',
  'root Spark dependency range mutation'
)
expectFailure(
  () =>
    assertProductionVendorDependencyPins(
      rootPackageSource,
      lockSource.replace(
        '"@dimforge/rapier3d-compat": "0.19.3"',
        '"@dimforge/rapier3d-compat": "^0.19.3"'
      )
    ),
  'bun.lock workspace must pin @dimforge/rapier3d-compat exactly',
  'Rapier lock range mutation'
)
expectFailure(
  () =>
    assertProductionVendorDependencyPins(
      rootPackageSource.replace('"three": "0.182.0"', '"three": "~0.182.0"'),
      lockSource
    ),
  'root package.json must pin three exactly',
  'root Three dependency range mutation'
)

expectFailure(
  () => assertSparkProductionOutput(sparkSource),
  'retains a direct fetch call',
  'untransformed Spark module'
)
expectFailure(
  () => assertRapierProductionOutput(rapierSource),
  'retains a direct fetch call',
  'untransformed Rapier module'
)
expectFailure(
  () => assertThreeCoreProductionOutput(threeCoreSource),
  'fetch identifier',
  'untransformed Three core module'
)
expectFailure(
  () => assertThreeGltfProductionOutput(threeGltfSource),
  'resource stack',
  'untransformed Three GLTFLoader module'
)

const restoredWorker = sparkWorker.replace(
  '(() => { throw new Error("Spark external WebAssembly loading is disabled in the production bundle") })()',
  'fetch(module_or_path)'
)
assert.notEqual(restoredWorker, sparkWorker, 'Spark worker mutation did not change the fixture')
expectFailure(
  () => assertSparkWorkerProductionSource(restoredWorker),
  'retains a direct fetch call',
  'Spark worker fetch restoration'
)

const brokenFileBytesPath = sparkOutput.replace(
  'else if (fileBytes) {',
  'else if (false && fileBytes) {'
)
assert.notEqual(
  brokenFileBytesPath,
  sparkOutput,
  'Spark fileBytes mutation did not change the fixture'
)
expectFailure(
  () => assertSparkProductionOutput(brokenFileBytesPath),
  'PackedSplats fileBytes initialization path drift',
  'Spark fileBytes path mutation'
)

const brokenSparkWasm = sparkOutput.replace('atob("AGFzbQ', 'atob("BGFzbQ')
assert.notEqual(
  brokenSparkWasm,
  sparkOutput,
  'Spark WebAssembly mutation did not change the fixture'
)
expectFailure(
  () => assertSparkProductionOutput(brokenSparkWasm),
  'base64 SHA-256',
  'Spark embedded WebAssembly mutation'
)

const restoredRapierFetch = rapierOutput.replace(
  '(() => { throw new Error("Rapier external WebAssembly loading is disabled in the production bundle") })()',
  'fetch(I)'
)
assert.notEqual(
  restoredRapierFetch,
  rapierOutput,
  'Rapier fetch mutation did not change the fixture'
)
expectFailure(
  () => assertRapierProductionOutput(restoredRapierFetch),
  'retains a direct fetch call',
  'Rapier fetch restoration'
)

const restoredThreeFileFetch = threeCoreOutput.replace(
  'Promise.reject(new Error("Three FileLoader network loading is disabled in the production bundle"))',
  'fetch(req)'
)
assert.notEqual(
  restoredThreeFileFetch,
  threeCoreOutput,
  'Three FileLoader mutation did not change the fixture'
)
expectFailure(
  () => assertThreeCoreProductionOutput(restoredThreeFileFetch),
  'fetch identifier',
  'Three FileLoader fetch restoration'
)

const widenedThreeImageGuard = threeCoreOutput.replace(
  '/^blob:[^\\s]+$/.test(url)',
  '/^https?:/.test(url)'
)
assert.notEqual(
  widenedThreeImageGuard,
  threeCoreOutput,
  'Three ImageLoader guard mutation did not change the fixture'
)
expectFailure(
  () => assertThreeCoreProductionOutput(widenedThreeImageGuard),
  'local-URL guard shape drift',
  'Three ImageLoader guard widening'
)

const restoredImageBitmapSelection = threeGltfOutput.replace(
  'this.textureLoader = new TextureLoader( this.options.manager );',
  'this.textureLoader = new ImageBitmapLoader( this.options.manager );'
)
assert.notEqual(
  restoredImageBitmapSelection,
  threeGltfOutput,
  'Three GLTF texture selection mutation did not change the fixture'
)
expectFailure(
  () => assertThreeGltfProductionOutput(restoredImageBitmapSelection),
  'exactly one TextureLoader and no ImageBitmapLoader',
  'Three ImageBitmapLoader selection restoration'
)

const widenedGltfUriGuard = threeGltfOutput.replace(
  "productionKey === 'uri' && ( typeof productionValue !== 'string' ||",
  "productionKey === 'never-uri' && ( typeof productionValue !== 'string' ||"
)
assert.notEqual(
  widenedGltfUriGuard,
  threeGltfOutput,
  'Three GLTF URI guard mutation did not change the fixture'
)
expectFailure(
  () => assertThreeGltfProductionOutput(widenedGltfUriGuard),
  'URI guard shape drift',
  'Three GLTF URI guard bypass'
)

const widenedGltfWorkLimit = threeGltfOutput.replace(
  'const productionResourceVisitLimit = 262144;',
  'const productionResourceVisitLimit = 262145;'
)
assert.notEqual(
  widenedGltfWorkLimit,
  threeGltfOutput,
  'Three GLTF URI work-limit mutation did not change the fixture'
)
expectFailure(
  () => assertThreeGltfProductionOutput(widenedGltfWorkLimit),
  'URI guard shape drift',
  'Three GLTF URI work-limit widening'
)

expectFailure(
  () =>
    assertNoForbiddenRuntimeCapabilities(
      'mutated-vendor.js',
      `${sparkOutput}\nglobalThis.fetch('/unexpected')`,
      { allowVendorFunctionConstructors: true }
    ),
  'member fetch',
  'post-transform capability injection'
)

expectFailure(
  () => plugin.transform(sparkSource, resolve(ROOT, sparkSpec.modulePath)),
  'transformed more than once',
  'duplicate Spark transform'
)
expectFailure(
  () => productionVendorBoundaryPlugin(ROOT).buildEnd(),
  'transform count must be exactly 1',
  'missing vendor transforms'
)

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942

function makeGlb(chunks) {
  const paddedLengths = chunks.map(({ bytes }) => Math.ceil(bytes.length / 4) * 4)
  const totalLength = 12 + paddedLengths.reduce((total, length) => total + 8 + length, 0)
  const output = new Uint8Array(totalLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, totalLength, true)
  let offset = 12
  chunks.forEach(({ bytes, type, paddingByte = 0 }, index) => {
    const paddedLength = paddedLengths[index]
    view.setUint32(offset, paddedLength, true)
    view.setUint32(offset + 4, type, true)
    output.fill(paddingByte, offset + 8, offset + 8 + paddedLength)
    output.set(bytes, offset + 8)
    offset += 8 + paddedLength
  })
  return output.buffer
}

function makeTexturedGlb(imageSource, extras) {
  const positions = new Uint8Array(36)
  const positionView = new DataView(positions.buffer)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) =>
    positionView.setFloat32(index * 4, value, true)
  )
  const png = Uint8Array.from(Buffer.from(PNG_1X1_BASE64, 'base64'))
  const usesBufferView = imageSource === 'bufferView'
  const binary = new Uint8Array(positions.length + (usesBufferView ? png.length : 0))
  binary.set(positions)
  if (usesBufferView) binary.set(png, positions.length)
  const image =
    imageSource === 'bufferView'
      ? { bufferView: 1, mimeType: 'image/png' }
      : imageSource === 'data'
        ? { uri: `data:image/png;base64,${PNG_1X1_BASE64}` }
        : imageSource === 'external'
          ? { uri: 'https://example.invalid/texture.png' }
          : { uri: 7 }
  const manifest = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      ...(usesBufferView
        ? [{ buffer: 0, byteOffset: positions.length, byteLength: png.length }]
        : []),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    images: [image],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...(extras === undefined ? {} : { extras }),
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  return makeGlb([
    { bytes: json, type: JSON_CHUNK_TYPE, paddingByte: 0x20 },
    { bytes: binary, type: BIN_CHUNK_TYPE },
  ])
}

function writeArrayBuffer(path, value) {
  writeFileSync(path, new Uint8Array(value))
}

function validateGlbFixturesWithProductValidator(temporaryDirectory, fixtures) {
  const fixturePaths = fixtures.map(({ name, value }) => {
    const path = join(temporaryDirectory, name)
    writeArrayBuffer(path, value)
    return path
  })
  const runnerPath = join(temporaryDirectory, 'validate-glb-fixtures.mjs')
  const validatorUrl = pathToFileURL(resolve(ROOT, 'src/lib/glbValidation.ts')).href
  writeFileSync(
    runnerPath,
    `import { readFileSync } from 'node:fs'\nimport { validateSelfContainedGlb } from ${JSON.stringify(validatorUrl)}\nfor (const path of process.argv.slice(2)) {\n  const bytes = readFileSync(path)\n  validateSelfContainedGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))\n}\n`
  )
  const result = spawnSync('bun', [runnerPath, ...fixturePaths], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(
    result.status,
    0,
    `textured GLB fixtures failed product validation: ${result.stderr || result.stdout}`
  )
}

function installTransformedThree(temporaryDirectory) {
  const packageRoot = join(temporaryDirectory, 'node_modules', 'three')
  const buildDirectory = join(packageRoot, 'build')
  const loaderDirectory = join(packageRoot, 'examples', 'jsm', 'loaders')
  const utilityDirectory = join(packageRoot, 'examples', 'jsm', 'utils')
  mkdirSync(buildDirectory, { recursive: true })
  mkdirSync(loaderDirectory, { recursive: true })
  mkdirSync(utilityDirectory, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), threePackageSource)
  writeFileSync(
    join(buildDirectory, 'three.module.js'),
    readFileSync(resolve(ROOT, threeSpec.modulePath))
  )
  writeFileSync(join(buildDirectory, 'three.core.js'), threeCoreOutput)
  writeFileSync(join(loaderDirectory, 'GLTFLoader.js'), threeGltfOutput)
  writeFileSync(
    join(utilityDirectory, 'BufferGeometryUtils.js'),
    readFileSync(resolve(ROOT, 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js'))
  )
  return { loaderPath: join(loaderDirectory, 'GLTFLoader.js'), packageRoot }
}

function runThreeRuntimeProof(temporaryDirectory, loaderPath, fixtures) {
  const fixturePaths = Object.fromEntries(
    Object.entries(fixtures).map(([name, value]) => {
      const path = join(temporaryDirectory, `${name}.glb`)
      writeArrayBuffer(path, value)
      return [name, path]
    })
  )
  const runnerPath = join(temporaryDirectory, 'run-three-boundary.mjs')
  writeFileSync(
    runnerPath,
    `import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const loaderPath = process.argv[2]
const fixturePaths = JSON.parse(process.argv[3])
const readArrayBuffer = (path) => {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
const decodedImageUrls = []
class ProductionBoundaryImage extends EventTarget {
  complete = false
  #src = ''
  get src() { return this.#src }
  set src(value) {
    this.#src = value
    this.complete = true
    decodedImageUrls.push(value)
    queueMicrotask(() => this.dispatchEvent(new Event('load')))
  }
}
Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis })
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElementNS(_namespace, name) {
      assert.equal(name, 'img')
      return new ProductionBoundaryImage()
    },
  },
})
Object.defineProperty(globalThis, 'createImageBitmap', {
  configurable: true,
  value: async () => { throw new Error('ImageBitmapLoader must remain unreachable') },
})
const { GLTFLoader } = await import(pathToFileURL(loaderPath).href)
const loader = new GLTFLoader()
const parseGlb = (bytes) => new Promise((resolve, reject) => loader.parse(bytes, '', resolve, reject))
const bufferViewResult = await parseGlb(readArrayBuffer(fixturePaths.bufferView))
const dataImageResult = await parseGlb(readArrayBuffer(fixturePaths.data))
assert.equal(bufferViewResult.scene.children.length, 1)
assert.equal(dataImageResult.scene.children.length, 1)
assert.equal(decodedImageUrls.length, 2)
assert.match(decodedImageUrls[0], /^blob:/)
assert.equal(decodedImageUrls[1], ${JSON.stringify(`data:image/png;base64,${PNG_1X1_BASE64}`)})
await assert.rejects(
  parseGlb(readArrayBuffer(fixturePaths.external)),
  /Three GLTFLoader rejected a non-self-contained resource URI/
)
await assert.rejects(
  parseGlb(readArrayBuffer(fixturePaths.nonString)),
  /Three GLTFLoader rejected a non-self-contained resource URI/
)
await assert.rejects(
  parseGlb(readArrayBuffer(fixturePaths.wide)),
  /Three GLTFLoader rejected a non-self-contained resource URI/
)
await new Promise((resolve, reject) => {
  loader.load(
    'https://example.invalid/drone.glb',
    () => reject(new Error('Three GLTFLoader.load unexpectedly succeeded')),
    undefined,
    (error) => {
      try {
        assert.match(String(error), /Three FileLoader network loading is disabled in the production bundle/)
        resolve()
      } catch (assertionError) {
        reject(assertionError)
      }
    }
  )
})
`
  )
  const result = spawnSync(
    process.execPath,
    [runnerPath, loaderPath, JSON.stringify(fixturePaths)],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    }
  )
  assert.equal(
    result.status,
    0,
    `transformed Three runtime proof failed: ${result.stderr || result.stdout}`
  )
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'crebain-vendor-boundary-'))
try {
  const bufferViewGlb = makeTexturedGlb('bufferView')
  const dataImageGlb = makeTexturedGlb('data')
  validateGlbFixturesWithProductValidator(temporaryDirectory, [
    { name: 'buffer-view-texture.glb', value: bufferViewGlb },
    { name: 'data-image-texture.glb', value: dataImageGlb },
  ])

  const { loaderPath } = installTransformedThree(temporaryDirectory)
  runThreeRuntimeProof(temporaryDirectory, loaderPath, {
    bufferView: bufferViewGlb,
    data: dataImageGlb,
    external: makeTexturedGlb('external'),
    nonString: makeTexturedGlb('non-string'),
    wide: makeTexturedGlb('data', new Array(262_145).fill(null)),
  })

  const droneTypesSource = readFileSync(resolve(ROOT, 'src/physics/DroneTypes.ts'), 'utf8')
  const modelPathValues = [...droneTypesSource.matchAll(/^    modelPath:\s*([^,\n]+),?$/gm)].map(
    (match) => match[1].trim()
  )
  assert.equal(modelPathValues.length, 5, 'immutable 0.9 drone type count drift')
  assert(
    modelPathValues.every((value) => value === 'null'),
    'a drone profile enables URL loading'
  )

  const sparkPath = join(temporaryDirectory, 'spark-transformed.mjs')
  writeFileSync(sparkPath, sparkOutput)
  const spark = await import(`${pathToFileURL(sparkPath).href}?sha=${sparkSpec.moduleSha256}`)
  await spark.SplatMesh.staticInitialized
  assert.equal(spark.SplatMesh.isStaticInitialized, true)

  const rapierPath = join(temporaryDirectory, 'rapier-transformed.mjs')
  writeFileSync(rapierPath, rapierOutput)
  const rapier = await import(`${pathToFileURL(rapierPath).href}?sha=${rapierSpec.moduleSha256}`)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...values) => warnings.push(values.map(String).join(' '))
  try {
    await rapier.init()
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(warnings, [
    'using deprecated parameters for the initialization function; pass a single object instead',
  ])
  assert.equal(rapier.version(), rapierSpec.version)
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 })
  assert.equal(world.gravity.y, -9.81)
  world.free()
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}

console.log(
  `OK: production vendor boundary passed (3 pinned packages, 4 transformed modules, ${negativeCases} fail-closed mutations, Spark/Rapier embedded-byte runtimes, two validated local-texture GLB runtimes, and bounded wide-manifest rejection)`
)
