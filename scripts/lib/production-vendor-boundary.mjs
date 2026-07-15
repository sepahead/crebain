import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const SPARK_EXTERNAL_WASM_ERROR =
  'Spark external WebAssembly loading is disabled in the production bundle'
const SPARK_URL_LOADING_ERROR = 'Spark URL loading is disabled in the production bundle'
const RAPIER_EXTERNAL_WASM_ERROR =
  'Rapier external WebAssembly loading is disabled in the production bundle'
const THREE_FILE_LOADING_ERROR =
  'Three FileLoader network loading is disabled in the production bundle'
const THREE_IMAGE_BITMAP_LOADING_ERROR =
  'Three ImageBitmapLoader network loading is disabled in the production bundle'
const THREE_IMAGE_URL_ERROR =
  'Three ImageLoader accepts only local blob or validated raster data URLs in the production bundle'
const THREE_GLTF_URI_ERROR =
  'Three GLTFLoader rejected a non-self-contained resource URI in the production bundle'
const DATA_WASM_PREFIX = 'data:application/wasm;base64,'
const THREE_LOCAL_IMAGE_GUARD_EXPRESSION = `url = typeof url === 'string' && (/^blob:[^\\s]+$/.test(url) || /^data:image\\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) ? url : (() => { throw new Error(${JSON.stringify(THREE_IMAGE_URL_ERROR)}) })()`
const THREE_GLTF_URI_GUARD_SOURCE = `const productionResourceStack = [ json ];
		const productionResourceVisitLimit = 262144;
		let productionResourceVisits = 0;

		while ( productionResourceStack.length > 0 ) {

			productionResourceVisits += 1;

			const productionResource = productionResourceStack.pop();

			if ( Array.isArray( productionResource ) ) {

				if ( productionResource.length > productionResourceVisitLimit - productionResourceVisits - productionResourceStack.length ) {

					if ( onError ) onError( new Error( ${JSON.stringify(THREE_GLTF_URI_ERROR)} ) );
					return;

				}

				for ( let productionIndex = 0; productionIndex < productionResource.length; productionIndex ++ ) {

					productionResourceStack.push( productionResource[ productionIndex ] );

				}

				continue;

			}

			if ( productionResource === null || typeof productionResource !== 'object' ) continue;

			const productionResourceEntries = Object.entries( productionResource );

			if ( productionResourceEntries.length > productionResourceVisitLimit - productionResourceVisits - productionResourceStack.length ) {

				if ( onError ) onError( new Error( ${JSON.stringify(THREE_GLTF_URI_ERROR)} ) );
				return;

			}

			for ( const [ productionKey, productionValue ] of productionResourceEntries ) {

				if ( productionKey === 'uri' && ( typeof productionValue !== 'string' || ! /^data:image\\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test( productionValue ) ) ) {

					if ( onError ) onError( new Error( ${JSON.stringify(THREE_GLTF_URI_ERROR)} ) );
					return;

				}

				productionResourceStack.push( productionValue );

			}

		}`

export const PINNED_PRODUCTION_VENDORS = Object.freeze({
  spark: Object.freeze({
    packageName: '@sparkjsdev/spark',
    version: '0.1.10',
    packagePath: 'node_modules/@sparkjsdev/spark/package.json',
    packageSha256: '0915170fdfdc3d023dfba3ca8f12467cc2cc351b65ba58445801bd59aa0d5e5a',
    modulePath: 'node_modules/@sparkjsdev/spark/dist/spark.module.js',
    moduleExport: './dist/spark.module.js',
    importExport: './dist/spark.module.js',
    moduleSha256: 'e2841904c3facdf2ab5177b13b4827cdc72118cb8b613673ca08d8e983c5bf9d',
    workerSha256: 'ab59eebfd5775f5b59f46bcd401c4274892a0d67286d404966a7cf662e552733',
    mainInitializerSha256: '20065581a795fac640e9f6a1dab0ec25b4647aadc28bd37c5fde0b9e90b8dc62',
    workerInitializerSha256: 'b8e2a446b62422115141f4bba1b6ea4977bdb0e9e19e072e958723aa86b8d062',
    fetchHelperSha256: '3ff7528230e0c48b7a46f715aa071da1489b357e891c0a503d65a224fc2318cd',
    loaderClassSha256: 'ce6f2301798fe62b0588fb1fa5a7a1d2342bee8a08b0b7893675b5c1ce052a3a',
    splatMeshInitializeSha256: '94ff2686537b08acbb0613d0a8d06be41326d76d00f98c6b653f03da0a83a2e0',
    packedSplatsInitializeSha256:
      'cbe14a57faa2467d19008deb7413ca5703a62652770471165765f4161c8d7cd3',
    wasmBase64Length: 43_024,
    wasmBase64Sha256: 'aa0155e2c687286bc8d8587c5eb7aa8e05cdb20a5b3a7b7536967083d9ea8d80',
    wasmByteLength: 32_266,
    wasmSha256: '4f8fd1684bd0587228be6d9aa5e9d2b6ce2d2d2c06d6bac778f4d75a48f5bb98',
  }),
  rapier: Object.freeze({
    packageName: '@dimforge/rapier3d-compat',
    version: '0.19.3',
    packagePath: 'node_modules/@dimforge/rapier3d-compat/package.json',
    packageSha256: '0e0b00bc0e8d0dd7afed4da18831a5bc416fce03637c64b48329898dfd9e3320',
    modulePath: 'node_modules/@dimforge/rapier3d-compat/rapier.mjs',
    moduleExport: 'rapier.mjs',
    importExport: './rapier.mjs',
    moduleSha256: 'bce2c762b440101ebf8cbff038a71fe1884488becd0a53b9a7c0a7e3daf13a2b',
    initializerSha256: '4b03490eeadd83f9fd41275f113a60d778c77d69641e395bc2cfff609146fbab',
    publicInitializerSha256: '284bb2288074b5acce937334515340b606646cd02ac8ba5fed24d1912d27ca30',
    wasmBase64Length: 2_092_784,
    wasmBase64Sha256: '118b532b89f8f2ee3f8f677d59ff69353bf6de1f8b2ee1c35e67f68bccd25210',
    wasmByteLength: 1_569_588,
    wasmSha256: '1ce1c8c4036b4dcd3bde86c6efdb0f270cf5e274979b1de6ab8052947ef166c5',
  }),
  three: Object.freeze({
    packageName: 'three',
    version: '0.182.0',
    packagePath: 'node_modules/three/package.json',
    packageSha256: 'e234d004910abe90f3451486d7ca9feaf7b9f4247b24d5a00233ff6e14bb67a0',
    modulePath: 'node_modules/three/build/three.module.js',
    moduleExport: './build/three.module.js',
    importExport: './build/three.module.js',
    moduleSha256: 'd835eab0b3bca3fdfd51e2ce7d06911f4a089b08db73cc3cd70fe5e3005a623f',
    coreModulePath: 'node_modules/three/build/three.core.js',
    coreModuleSha256: '283be43b2229e15f46dac84cd19354ede5f06cac7ffb185e765cfcfb2c1eec90',
    fileLoaderClassSha256: 'ba96c77686b9a3caf2f1109a48d3f78dcb1d488dd35863fe365500d48c31e6d9',
    fileLoaderLoadSha256: '81d66c877b8d7cf8987bb0ba23749d30a8f61b4260b28332d3b88b98003303ec',
    imageBitmapLoaderClassSha256:
      'f113267249769a5246192bb91ed63a91f33604758faa083105375eb129302796',
    imageBitmapLoaderLoadSha256: '0e68d206a52f1cfc4cd01f4e45ae3fdaa0f196357e9792d6a5a295a444b6d1bf',
    imageBitmapFetchSupportSha256:
      'c0d0204b925774eb3eb762ed958c85b6301daaf92ecc363da19cda35ae3e0555',
    imageLoaderClassSha256: '36b451972d79fd42cee9d2e7fcd62fcc86ea51bf9df5596366ea87acc6591b54',
    imageLoaderLoadSha256: '926e920daf95519e0dd0f49b1acd8806dd1b803a92e13c0ae39631c8308d88e7',
    imageLoaderResolveSha256: 'ff910905e1e6a165d41bf299564693807b55bcdf217f91237c215714b29b560d',
    imageSourceAssignmentSha256: 'e49f29bc837fba6e47281ad1acb4213a11e0cef09ad17e6f96613f34c9d83e2f',
    gltfLoaderPath: 'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
    gltfLoaderSha256: 'a2d45c28c56774cc789b99154e914c34db3197f9ea2b89fee27600cc2509b14f',
    gltfLoaderClassSha256: '4830526cd212f953fb7f8f995ce95567a044d0b61cdf45c42951d56918442445',
    gltfLoaderLoadSha256: 'fb26c3ded3424fcd21076444ee7aafef0d445c7cceabbf9e637a053794b85fd1',
    gltfLoaderParseSha256: 'c8b3a07c93ae713f79707132c443f86d2a645c3632ab7912782c1975ba88809a',
    gltfAssetCheckSha256: 'd8b5a3892e25ead1a7b1d4b44473a65d5525edc51fc18caafa443e39f60e1ad9',
    gltfParserClassSha256: '4e3530fcb55a3f9b6dd9f91d724dfef6b91a9135de8f65351c5b6c86767ba5f0',
    gltfParserConstructorSha256: '2ad3bd726d8823f458e25ff8d6b4b408c83feca5db55ebb826019ae708c2bec8',
    gltfTextureSelectionSha256: '42de59aabb74bc667a4a3b6e6f3dd02321a53005598f661b448e7c147399cbd1',
  }),
})

function fail(message) {
  throw new Error(`Production vendor boundary failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseJavaScript(source, label) {
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  assert(
    sourceFile.parseDiagnostics.length === 0,
    `${label} is not valid JavaScript: ${sourceFile.parseDiagnostics
      .map((diagnostic) => diagnostic.messageText)
      .join('; ')}`
  )
  return sourceFile
}

function collectNodes(root, predicate) {
  const matches = []
  const visit = (node) => {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return matches
}

function nodeSha256(source, sourceFile, node) {
  return sha256(source.slice(node.getStart(sourceFile), node.end))
}

function identifierName(node) {
  return ts.isIdentifier(node) ? node.text : null
}

function namedFunctions(sourceFile, name) {
  return collectNodes(
    sourceFile,
    (node) => ts.isFunctionDeclaration(node) && identifierName(node.name) === name
  )
}

function namedClasses(sourceFile, name) {
  return collectNodes(
    sourceFile,
    (node) =>
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      identifierName(node.name) === name
  )
}

function namedMethods(sourceFile, name) {
  return collectNodes(
    sourceFile,
    (node) => ts.isMethodDeclaration(node) && node.name?.getText(sourceFile) === name
  )
}

function directCalls(sourceFile, name, root = sourceFile) {
  return collectNodes(
    root,
    (node) => ts.isCallExpression(node) && identifierName(node.expression) === name
  )
}

function exactSingle(values, label) {
  assert(values.length === 1, `${label} count must be exactly 1, got ${values.length}`)
  return values[0]
}

function exactClassMethod(sourceFile, classNode, name, label) {
  return exactSingle(
    classNode.members.filter(
      (member) => ts.isMethodDeclaration(member) && member.name?.getText(sourceFile) === name
    ),
    label
  )
}

function exactClassConstructor(classNode, label) {
  return exactSingle(classNode.members.filter(ts.isConstructorDeclaration), label)
}

function firstAncestor(node, predicate) {
  let current = node.parent
  while (current) {
    if (predicate(current)) return current
    current = current.parent
  }
  return null
}

function validateEmbeddedWasm(base64, spec, label) {
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(base64), `${label} is not canonical base64`)
  assert(
    base64.length === spec.wasmBase64Length,
    `${label} base64 length drift: expected ${spec.wasmBase64Length}, got ${base64.length}`
  )
  assert(
    sha256(base64) === spec.wasmBase64Sha256,
    `${label} base64 SHA-256 does not match the pinned payload`
  )
  const bytes = Buffer.from(base64, 'base64')
  assert(
    bytes.length === spec.wasmByteLength,
    `${label} byte length drift: expected ${spec.wasmByteLength}, got ${bytes.length}`
  )
  assert(
    sha256(bytes) === spec.wasmSha256,
    `${label} byte SHA-256 does not match the pinned payload`
  )
  assert(WebAssembly.validate(bytes), `${label} is not a valid WebAssembly module`)
}

function applyReplacements(source, replacements, label) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start)
  let previousStart = source.length
  let output = source
  for (const replacement of ordered) {
    assert(
      Number.isSafeInteger(replacement.start) &&
        Number.isSafeInteger(replacement.end) &&
        replacement.start >= 0 &&
        replacement.end > replacement.start &&
        replacement.end <= source.length,
      `${label} has an invalid replacement range`
    )
    assert(replacement.end <= previousStart, `${label} replacements overlap`)
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
    previousStart = replacement.start
  }
  return output
}

function extractSparkWorker(source, sourceFile) {
  const declaration = exactSingle(
    collectNodes(
      sourceFile,
      (node) =>
        ts.isVariableDeclaration(node) &&
        identifierName(node.name) === 'jsContent' &&
        ts.isStringLiteral(node.initializer)
    ),
    'Spark jsContent declaration'
  )
  return { declaration, literal: declaration.initializer, source: declaration.initializer.text }
}

function sparkInitializerReplacements(source, sourceFile, expectedHash, expectedBaseUrl, label) {
  const spec = PINNED_PRODUCTION_VENDORS.spark
  const initializer = exactSingle(namedFunctions(sourceFile, '__wbg_init'), `${label} initializer`)
  assert(
    nodeSha256(source, sourceFile, initializer) === expectedHash,
    `${label} initializer shape does not match Spark 0.1.10`
  )
  assert(
    initializer.parameters.length === 1 &&
      identifierName(initializer.parameters[0].name) === 'module_or_path',
    `${label} initializer parameter shape drift`
  )

  const urlInitializer = exactSingle(
    collectNodes(
      initializer,
      (node) =>
        ts.isNewExpression(node) &&
        identifierName(node.expression) === 'URL' &&
        node.arguments?.length === 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith(DATA_WASM_PREFIX)
    ),
    `${label} embedded WebAssembly URL initializer`
  )
  assert(
    urlInitializer.arguments[1].getText(sourceFile) === expectedBaseUrl,
    `${label} embedded WebAssembly base URL drift`
  )
  assert(
    ts.isBinaryExpression(urlInitializer.parent) &&
      urlInitializer.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(urlInitializer.parent.left) === 'module_or_path',
    `${label} embedded WebAssembly assignment shape drift`
  )
  const base64 = urlInitializer.arguments[0].text.slice(DATA_WASM_PREFIX.length)
  validateEmbeddedWasm(base64, spec, `${label} embedded WebAssembly`)

  const fetchCall = exactSingle(
    directCalls(sourceFile, 'fetch', initializer),
    `${label} fetch call`
  )
  assert(
    fetchCall.arguments.length === 1 && identifierName(fetchCall.arguments[0]) === 'module_or_path',
    `${label} fetch argument shape drift`
  )
  assert(
    ts.isBinaryExpression(fetchCall.parent) &&
      fetchCall.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(fetchCall.parent.left) === 'module_or_path',
    `${label} fetch assignment shape drift`
  )

  return [
    {
      start: urlInitializer.getStart(sourceFile),
      end: urlInitializer.end,
      text: `Uint8Array.from(atob(${JSON.stringify(base64)}), (character) => character.charCodeAt(0))`,
    },
    {
      start: fetchCall.getStart(sourceFile),
      end: fetchCall.end,
      text: `(() => { throw new Error(${JSON.stringify(SPARK_EXTERNAL_WASM_ERROR)}) })()`,
    },
  ]
}

function assertSparkFileBytesPath(source, sourceFile) {
  const spec = PINNED_PRODUCTION_VENDORS.spark
  const loader = exactSingle(namedClasses(sourceFile, 'SplatLoader'), 'Spark SplatLoader class')
  assert(
    nodeSha256(source, sourceFile, loader) === spec.loaderClassSha256,
    'Spark SplatLoader class shape drift'
  )
  assert(
    directCalls(sourceFile, 'fetchWithProgress', loader).length === 2,
    'Spark SplatLoader must retain exactly two calls through the disabled URL helper'
  )

  const initializeMethods = namedMethods(sourceFile, 'asyncInitialize')
  assert(
    initializeMethods.length === 2,
    `Spark asyncInitialize method count must be exactly 2, got ${initializeMethods.length}`
  )
  const methodHashes = new Set(
    initializeMethods.map((method) => nodeSha256(source, sourceFile, method))
  )
  assert(
    methodHashes.has(spec.splatMeshInitializeSha256),
    'Spark SplatMesh fileBytes initialization path drift'
  )
  assert(
    methodHashes.has(spec.packedSplatsInitializeSha256),
    'Spark PackedSplats fileBytes initialization path drift'
  )
}

function assertSparkInitializerOutput(source, sourceFile, label) {
  const spec = PINNED_PRODUCTION_VENDORS.spark
  const initializer = exactSingle(namedFunctions(sourceFile, '__wbg_init'), `${label} initializer`)
  assert(
    directCalls(sourceFile, 'fetch', initializer).length === 0,
    `${label} initializer retains a direct fetch call`
  )
  const atobCall = exactSingle(directCalls(sourceFile, 'atob', initializer), `${label} atob call`)
  assert(
    atobCall.arguments.length === 1 && ts.isStringLiteral(atobCall.arguments[0]),
    `${label} embedded-byte decoder shape drift`
  )
  validateEmbeddedWasm(atobCall.arguments[0].text, spec, `${label} transformed WebAssembly`)
  const errors = collectNodes(
    initializer,
    (node) => ts.isStringLiteral(node) && node.text === SPARK_EXTERNAL_WASM_ERROR
  )
  assert(errors.length === 1, `${label} external-input rejection count must be exactly 1`)
}

export function extractSparkWorkerSource(source) {
  const sourceFile = parseJavaScript(source, 'transformed Spark module')
  return extractSparkWorker(source, sourceFile).source
}

export function assertSparkWorkerProductionSource(source) {
  const sourceFile = parseJavaScript(source, 'transformed Spark worker')
  assert(
    directCalls(sourceFile, 'fetch').length === 0,
    'transformed Spark worker retains a direct fetch call'
  )
  assertSparkInitializerOutput(source, sourceFile, 'transformed Spark worker')
}

export function assertSparkProductionOutput(source) {
  const sourceFile = parseJavaScript(source, 'transformed Spark module')
  assert(
    directCalls(sourceFile, 'fetch').length === 0,
    'transformed Spark module retains a direct fetch call'
  )
  assertSparkInitializerOutput(source, sourceFile, 'transformed Spark main module')
  assertSparkFileBytesPath(source, sourceFile)

  const fetchHelper = exactSingle(
    namedFunctions(sourceFile, 'fetchWithProgress'),
    'transformed Spark URL helper'
  )
  const expectedBody = `{ throw new Error(${JSON.stringify(SPARK_URL_LOADING_ERROR)}) }`
  assert(
    fetchHelper.body?.getText(sourceFile) === expectedBody,
    'transformed Spark URL helper is not the exact fail-closed body'
  )
  assert(
    directCalls(sourceFile, 'fetchWithProgress').length === 2,
    'transformed Spark URL helper call count drift'
  )

  const worker = extractSparkWorker(source, sourceFile)
  assertSparkWorkerProductionSource(worker.source)
}

export function transformSparkProductionSource(source) {
  const spec = PINNED_PRODUCTION_VENDORS.spark
  assert(
    sha256(source) === spec.moduleSha256,
    `Spark module SHA-256 does not match pinned ${spec.packageName} ${spec.version}`
  )
  const sourceFile = parseJavaScript(source, 'pinned Spark module')
  assertSparkFileBytesPath(source, sourceFile)

  const fetchHelper = exactSingle(
    namedFunctions(sourceFile, 'fetchWithProgress'),
    'Spark URL helper'
  )
  assert(
    nodeSha256(source, sourceFile, fetchHelper) === spec.fetchHelperSha256,
    'Spark URL helper shape does not match 0.1.10'
  )
  assert(fetchHelper.body, 'Spark URL helper has no body')

  const worker = extractSparkWorker(source, sourceFile)
  assert(
    sha256(worker.source) === spec.workerSha256,
    'Spark embedded worker SHA-256 does not match 0.1.10'
  )
  const workerSourceFile = parseJavaScript(worker.source, 'pinned Spark worker')
  const transformedWorker = applyReplacements(
    worker.source,
    sparkInitializerReplacements(
      worker.source,
      workerSourceFile,
      spec.workerInitializerSha256,
      'self.location.href',
      'Spark worker'
    ),
    'Spark worker'
  )

  const replacements = [
    ...sparkInitializerReplacements(
      source,
      sourceFile,
      spec.mainInitializerSha256,
      'import.meta.url',
      'Spark main module'
    ),
    {
      start: fetchHelper.body.getStart(sourceFile),
      end: fetchHelper.body.end,
      text: `{ throw new Error(${JSON.stringify(SPARK_URL_LOADING_ERROR)}) }`,
    },
    {
      start: worker.literal.getStart(sourceFile),
      end: worker.literal.end,
      text: JSON.stringify(transformedWorker),
    },
  ]
  assert(replacements.length === 4, 'Spark replacement count drift')
  const output = applyReplacements(source, replacements, 'Spark module')
  assertSparkProductionOutput(output)
  return output
}

function rapierEmbeddedWasm(source, sourceFile) {
  const spec = PINNED_PRODUCTION_VENDORS.rapier
  const publicInitializer = exactSingle(
    namedFunctions(sourceFile, 'dg'),
    'Rapier public initializer'
  )
  assert(
    nodeSha256(source, sourceFile, publicInitializer) === spec.publicInitializerSha256,
    'Rapier public embedded-byte initializer shape does not match 0.19.3'
  )
  const strings = collectNodes(publicInitializer, ts.isStringLiteral)
  const base64 = exactSingle(strings, 'Rapier public initializer string').text
  validateEmbeddedWasm(base64, spec, 'Rapier embedded WebAssembly')
  const calls = directCalls(sourceFile, 'xA', publicInitializer)
  assert(
    calls.length === 1,
    `Rapier public initializer xA call count must be 1, got ${calls.length}`
  )
  const embeddedBytes = calls[0].arguments[0]
  assert(
    calls[0].arguments.length === 1 &&
      ts.isPropertyAccessExpression(embeddedBytes) &&
      embeddedBytes.name.text === 'buffer' &&
      ts.isCallExpression(embeddedBytes.expression) &&
      embeddedBytes.expression.expression.getText(sourceFile) === 'Lg.toByteArray' &&
      embeddedBytes.expression.arguments.length === 1 &&
      embeddedBytes.expression.arguments[0] === strings[0],
    'Rapier public initializer must pass embedded decoded bytes to xA'
  )
}

function rapierInitializer(source, sourceFile, requirePinnedHash) {
  const spec = PINNED_PRODUCTION_VENDORS.rapier
  const initializer = exactSingle(namedFunctions(sourceFile, 'xA'), 'Rapier internal initializer')
  if (requirePinnedHash) {
    assert(
      nodeSha256(source, sourceFile, initializer) === spec.initializerSha256,
      'Rapier internal initializer shape does not match 0.19.3'
    )
  }
  assert(
    initializer.parameters.length === 1 && identifierName(initializer.parameters[0].name) === 'I',
    'Rapier internal initializer parameter shape drift'
  )
  const externalDefault = exactSingle(
    collectNodes(
      initializer,
      (node) =>
        ts.isNewExpression(node) &&
        identifierName(node.expression) === 'URL' &&
        node.arguments?.length === 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'rapier_wasm3d_bg.wasm' &&
        ts.isStringLiteral(node.arguments[1]) &&
        node.arguments[1].text === '<deleted>'
    ),
    'Rapier external default URL'
  )
  assert(
    ts.isBinaryExpression(externalDefault.parent) &&
      externalDefault.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(externalDefault.parent.left) === 'I',
    'Rapier external default assignment shape drift'
  )
  return initializer
}

export function assertRapierProductionOutput(source) {
  const sourceFile = parseJavaScript(source, 'transformed Rapier module')
  assert(
    directCalls(sourceFile, 'fetch').length === 0,
    'transformed Rapier module retains a direct fetch call'
  )
  const initializer = rapierInitializer(source, sourceFile, false)
  const errors = collectNodes(
    initializer,
    (node) => ts.isStringLiteral(node) && node.text === RAPIER_EXTERNAL_WASM_ERROR
  )
  assert(errors.length === 1, 'Rapier external-input rejection count must be exactly 1')
  rapierEmbeddedWasm(source, sourceFile)
}

export function transformRapierProductionSource(source) {
  const spec = PINNED_PRODUCTION_VENDORS.rapier
  assert(
    sha256(source) === spec.moduleSha256,
    `Rapier module SHA-256 does not match pinned ${spec.packageName} ${spec.version}`
  )
  const sourceFile = parseJavaScript(source, 'pinned Rapier module')
  rapierEmbeddedWasm(source, sourceFile)
  const initializer = rapierInitializer(source, sourceFile, true)
  const fetchCall = exactSingle(directCalls(sourceFile, 'fetch', initializer), 'Rapier fetch call')
  assert(
    fetchCall.arguments.length === 1 && identifierName(fetchCall.arguments[0]) === 'I',
    'Rapier fetch argument shape drift'
  )
  assert(
    ts.isBinaryExpression(fetchCall.parent) &&
      fetchCall.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(fetchCall.parent.left) === 'I',
    'Rapier fetch assignment shape drift'
  )
  const output = applyReplacements(
    source,
    [
      {
        start: fetchCall.getStart(sourceFile),
        end: fetchCall.end,
        text: `(() => { throw new Error(${JSON.stringify(RAPIER_EXTERNAL_WASM_ERROR)}) })()`,
      },
    ],
    'Rapier module'
  )
  assertRapierProductionOutput(output)
  return output
}

function threeCoreInputShape(source, sourceFile) {
  const spec = PINNED_PRODUCTION_VENDORS.three
  const fileLoader = exactSingle(namedClasses(sourceFile, 'FileLoader'), 'Three FileLoader class')
  const fileLoad = exactClassMethod(sourceFile, fileLoader, 'load', 'Three FileLoader.load method')
  assert(
    nodeSha256(source, sourceFile, fileLoader) === spec.fileLoaderClassSha256,
    'Three FileLoader class shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, fileLoad) === spec.fileLoaderLoadSha256,
    'Three FileLoader.load shape does not match 0.182.0'
  )
  const fileFetch = exactSingle(
    directCalls(sourceFile, 'fetch', fileLoad),
    'Three FileLoader fetch'
  )
  assert(
    fileFetch.arguments.length === 1 && identifierName(fileFetch.arguments[0]) === 'req',
    'Three FileLoader fetch argument shape drift'
  )

  const imageBitmapLoader = exactSingle(
    namedClasses(sourceFile, 'ImageBitmapLoader'),
    'Three ImageBitmapLoader class'
  )
  const imageBitmapLoad = exactClassMethod(
    sourceFile,
    imageBitmapLoader,
    'load',
    'Three ImageBitmapLoader.load method'
  )
  assert(
    nodeSha256(source, sourceFile, imageBitmapLoader) === spec.imageBitmapLoaderClassSha256,
    'Three ImageBitmapLoader class shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, imageBitmapLoad) === spec.imageBitmapLoaderLoadSha256,
    'Three ImageBitmapLoader.load shape does not match 0.182.0'
  )
  const imageBitmapFetch = exactSingle(
    directCalls(sourceFile, 'fetch', imageBitmapLoad),
    'Three ImageBitmapLoader fetch'
  )
  assert(
    imageBitmapFetch.arguments.length === 2 &&
      identifierName(imageBitmapFetch.arguments[0]) === 'url' &&
      identifierName(imageBitmapFetch.arguments[1]) === 'fetchOptions',
    'Three ImageBitmapLoader fetch argument shape drift'
  )
  const fetchIdentifiers = collectNodes(
    sourceFile,
    (node) => ts.isIdentifier(node) && node.text === 'fetch'
  )
  assert(
    fetchIdentifiers.length === 3,
    `Three core fetch identifier count must be exactly 3, got ${fetchIdentifiers.length}`
  )
  const fetchSupportIdentifier = exactSingle(
    fetchIdentifiers.filter((identifier) => ts.isTypeOfExpression(identifier.parent)),
    'Three ImageBitmapLoader fetch support check'
  )
  const fetchSupportIf = firstAncestor(fetchSupportIdentifier, ts.isIfStatement)
  assert(fetchSupportIf, 'Three ImageBitmapLoader fetch support statement is missing')
  assert(
    nodeSha256(source, sourceFile, fetchSupportIf) === spec.imageBitmapFetchSupportSha256,
    'Three ImageBitmapLoader fetch support check shape does not match 0.182.0'
  )

  const imageLoader = exactSingle(
    namedClasses(sourceFile, 'ImageLoader'),
    'Three ImageLoader class'
  )
  const imageLoad = exactClassMethod(
    sourceFile,
    imageLoader,
    'load',
    'Three ImageLoader.load method'
  )
  assert(
    nodeSha256(source, sourceFile, imageLoader) === spec.imageLoaderClassSha256,
    'Three ImageLoader class shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, imageLoad) === spec.imageLoaderLoadSha256,
    'Three ImageLoader.load shape does not match 0.182.0'
  )
  const imageResolve = exactSingle(
    collectNodes(
      imageLoad,
      (node) =>
        ts.isExpressionStatement(node) &&
        node.expression.getText(sourceFile) === 'url = this.manager.resolveURL( url )'
    ),
    'Three ImageLoader URL resolution'
  )
  assert(
    nodeSha256(source, sourceFile, imageResolve) === spec.imageLoaderResolveSha256,
    'Three ImageLoader URL resolution shape does not match 0.182.0'
  )
  const imageSourceAssignment = exactSingle(
    collectNodes(
      imageLoad,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(sourceFile) === 'image.src'
    ),
    'Three ImageLoader image.src assignment'
  )
  assert(
    nodeSha256(source, sourceFile, imageSourceAssignment) === spec.imageSourceAssignmentSha256 &&
      identifierName(imageSourceAssignment.right) === 'url',
    'Three ImageLoader image.src assignment shape does not match 0.182.0'
  )

  return {
    fetchSupportIf,
    fileFetch,
    imageBitmapFetch,
    imageResolve,
  }
}

function assertPromiseRejects(method, sourceFile, errorText, label) {
  const rejection = exactSingle(
    collectNodes(
      method,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        identifierName(node.expression.expression) === 'Promise' &&
        node.expression.name.text === 'reject'
    ),
    `${label} Promise.reject call`
  )
  assert(
    rejection.arguments.length === 1 &&
      ts.isNewExpression(rejection.arguments[0]) &&
      identifierName(rejection.arguments[0].expression) === 'Error' &&
      rejection.arguments[0].arguments?.length === 1 &&
      ts.isStringLiteral(rejection.arguments[0].arguments[0]) &&
      rejection.arguments[0].arguments[0].text === errorText,
    `${label} rejection shape drift`
  )
}

export function assertThreeCoreProductionOutput(source) {
  const sourceFile = parseJavaScript(source, 'transformed Three core module')
  const fetchIdentifiers = collectNodes(
    sourceFile,
    (node) => ts.isIdentifier(node) && node.text === 'fetch'
  )
  assert(
    fetchIdentifiers.length === 0,
    `transformed Three core retains ${fetchIdentifiers.length} fetch identifier(s)`
  )

  const fileLoader = exactSingle(
    namedClasses(sourceFile, 'FileLoader'),
    'transformed Three FileLoader class'
  )
  const fileLoad = exactClassMethod(
    sourceFile,
    fileLoader,
    'load',
    'transformed Three FileLoader.load method'
  )
  assertPromiseRejects(fileLoad, sourceFile, THREE_FILE_LOADING_ERROR, 'Three FileLoader')

  const imageBitmapLoader = exactSingle(
    namedClasses(sourceFile, 'ImageBitmapLoader'),
    'transformed Three ImageBitmapLoader class'
  )
  const imageBitmapLoad = exactClassMethod(
    sourceFile,
    imageBitmapLoader,
    'load',
    'transformed Three ImageBitmapLoader.load method'
  )
  assertPromiseRejects(
    imageBitmapLoad,
    sourceFile,
    THREE_IMAGE_BITMAP_LOADING_ERROR,
    'Three ImageBitmapLoader'
  )

  const imageLoader = exactSingle(
    namedClasses(sourceFile, 'ImageLoader'),
    'transformed Three ImageLoader class'
  )
  const imageLoad = exactClassMethod(
    sourceFile,
    imageLoader,
    'load',
    'transformed Three ImageLoader.load method'
  )
  const guardError = exactSingle(
    collectNodes(
      imageLoad,
      (node) => ts.isStringLiteral(node) && node.text === THREE_IMAGE_URL_ERROR
    ),
    'transformed Three ImageLoader local-URL guard error'
  )
  const guardAssignment = firstAncestor(
    guardError,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(node.left) === 'url'
  )
  assert(guardAssignment, 'transformed Three ImageLoader local-URL guard is missing')
  assert(
    guardAssignment.getText(sourceFile) === THREE_LOCAL_IMAGE_GUARD_EXPRESSION,
    'transformed Three ImageLoader local-URL guard shape drift'
  )
  const imageSourceAssignment = exactSingle(
    collectNodes(
      imageLoad,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(sourceFile) === 'image.src'
    ),
    'transformed Three ImageLoader image.src assignment'
  )
  assert(
    identifierName(imageSourceAssignment.right) === 'url' &&
      guardAssignment.end < imageSourceAssignment.getStart(sourceFile),
    'transformed Three ImageLoader image.src is not dominated by the local-URL guard'
  )
  const interveningUrlWrites = collectNodes(
    imageLoad,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifierName(node.left) === 'url' &&
      node.getStart(sourceFile) > guardAssignment.end &&
      node.end < imageSourceAssignment.getStart(sourceFile)
  )
  assert(
    interveningUrlWrites.length === 0,
    'transformed Three ImageLoader rewrites the guarded URL before image.src'
  )
}

export function transformThreeCoreProductionSource(source) {
  const spec = PINNED_PRODUCTION_VENDORS.three
  assert(
    sha256(source) === spec.coreModuleSha256,
    `Three core module SHA-256 does not match pinned ${spec.packageName} ${spec.version}`
  )
  const sourceFile = parseJavaScript(source, 'pinned Three core module')
  const shape = threeCoreInputShape(source, sourceFile)
  const output = applyReplacements(
    source,
    [
      {
        start: shape.fileFetch.getStart(sourceFile),
        end: shape.fileFetch.end,
        text: `Promise.reject(new Error(${JSON.stringify(THREE_FILE_LOADING_ERROR)}))`,
      },
      {
        start: shape.imageBitmapFetch.getStart(sourceFile),
        end: shape.imageBitmapFetch.end,
        text: `Promise.reject(new Error(${JSON.stringify(THREE_IMAGE_BITMAP_LOADING_ERROR)}))`,
      },
      {
        start: shape.fetchSupportIf.getStart(sourceFile),
        end: shape.fetchSupportIf.end,
        text: ';',
      },
      {
        start: shape.imageResolve.getStart(sourceFile),
        end: shape.imageResolve.end,
        text: `${shape.imageResolve.getText(sourceFile)}\n\n\t\t${THREE_LOCAL_IMAGE_GUARD_EXPRESSION};`,
      },
    ],
    'Three core module'
  )
  assertThreeCoreProductionOutput(output)
  return output
}

function threeGltfInputShape(source, sourceFile) {
  const spec = PINNED_PRODUCTION_VENDORS.three
  const loader = exactSingle(namedClasses(sourceFile, 'GLTFLoader'), 'Three GLTFLoader class')
  const load = exactClassMethod(sourceFile, loader, 'load', 'Three GLTFLoader.load method')
  const parse = exactClassMethod(sourceFile, loader, 'parse', 'Three GLTFLoader.parse method')
  assert(
    nodeSha256(source, sourceFile, loader) === spec.gltfLoaderClassSha256,
    'Three GLTFLoader class shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, load) === spec.gltfLoaderLoadSha256,
    'Three GLTFLoader.load shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, parse) === spec.gltfLoaderParseSha256,
    'Three GLTFLoader.parse shape does not match 0.182.0'
  )
  const assetCheck = exactSingle(
    collectNodes(
      parse,
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText(sourceFile) ===
          'json.asset === undefined || json.asset.version[ 0 ] < 2'
    ),
    'Three GLTFLoader asset-version check'
  )
  assert(
    nodeSha256(source, sourceFile, assetCheck) === spec.gltfAssetCheckSha256,
    'Three GLTFLoader asset-version check shape does not match 0.182.0'
  )

  const parser = exactSingle(namedClasses(sourceFile, 'GLTFParser'), 'Three GLTFParser class')
  const constructor = exactClassConstructor(parser, 'Three GLTFParser constructor')
  assert(
    nodeSha256(source, sourceFile, parser) === spec.gltfParserClassSha256,
    'Three GLTFParser class shape does not match 0.182.0'
  )
  assert(
    nodeSha256(source, sourceFile, constructor) === spec.gltfParserConstructorSha256,
    'Three GLTFParser constructor shape does not match 0.182.0'
  )
  const imageBitmapConstruction = exactSingle(
    collectNodes(
      constructor,
      (node) => ts.isNewExpression(node) && identifierName(node.expression) === 'ImageBitmapLoader'
    ),
    'Three GLTFParser ImageBitmapLoader selection'
  )
  const textureSelection = firstAncestor(imageBitmapConstruction, ts.isIfStatement)
  assert(textureSelection, 'Three GLTFParser texture-loader selection is missing')
  assert(
    nodeSha256(source, sourceFile, textureSelection) === spec.gltfTextureSelectionSha256,
    'Three GLTFParser texture-loader selection shape does not match 0.182.0'
  )
  assert(
    collectNodes(
      textureSelection,
      (node) => ts.isNewExpression(node) && identifierName(node.expression) === 'TextureLoader'
    ).length === 1,
    'Three GLTFParser TextureLoader selection count drift'
  )
  return { assetCheck, load, parse, textureSelection }
}

export function assertThreeGltfProductionOutput(source) {
  const spec = PINNED_PRODUCTION_VENDORS.three
  const sourceFile = parseJavaScript(source, 'transformed Three GLTFLoader module')
  const loader = exactSingle(
    namedClasses(sourceFile, 'GLTFLoader'),
    'transformed Three GLTFLoader class'
  )
  const load = exactClassMethod(
    sourceFile,
    loader,
    'load',
    'transformed Three GLTFLoader.load method'
  )
  const parse = exactClassMethod(
    sourceFile,
    loader,
    'parse',
    'transformed Three GLTFLoader.parse method'
  )
  assert(
    nodeSha256(source, sourceFile, load) === spec.gltfLoaderLoadSha256,
    'transformed Three GLTFLoader.load path drift'
  )
  const resourceStack = exactSingle(
    collectNodes(
      parse,
      (node) =>
        ts.isVariableDeclaration(node) && identifierName(node.name) === 'productionResourceStack'
    ),
    'transformed Three GLTFLoader resource stack'
  )
  const resourceStackStatement = resourceStack.parent.parent
  assert(
    ts.isVariableStatement(resourceStackStatement),
    'transformed Three GLTFLoader resource stack statement shape drift'
  )
  const uriGuard = exactSingle(
    collectNodes(
      parse,
      (node) =>
        ts.isWhileStatement(node) &&
        node.expression.getText(sourceFile) === 'productionResourceStack.length > 0'
    ),
    'transformed Three GLTFLoader URI guard loop'
  )
  assert(
    source.slice(resourceStackStatement.getStart(sourceFile), uriGuard.end) ===
      THREE_GLTF_URI_GUARD_SOURCE,
    'transformed Three GLTFLoader URI guard shape drift'
  )
  const uriErrors = collectNodes(
    parse,
    (node) => ts.isStringLiteral(node) && node.text === THREE_GLTF_URI_ERROR
  )
  assert(uriErrors.length === 3, 'transformed Three GLTFLoader URI rejection count drift')

  const parser = exactSingle(
    namedClasses(sourceFile, 'GLTFParser'),
    'transformed Three GLTFParser class'
  )
  const constructor = exactClassConstructor(parser, 'transformed Three GLTFParser constructor')
  const imageBitmapConstructions = collectNodes(
    constructor,
    (node) => ts.isNewExpression(node) && identifierName(node.expression) === 'ImageBitmapLoader'
  )
  const textureConstructions = collectNodes(
    constructor,
    (node) => ts.isNewExpression(node) && identifierName(node.expression) === 'TextureLoader'
  )
  assert(
    imageBitmapConstructions.length === 0 && textureConstructions.length === 1,
    'transformed Three GLTFParser must select exactly one TextureLoader and no ImageBitmapLoader'
  )
  const textureAssignment = firstAncestor(textureConstructions[0], ts.isExpressionStatement)
  assert(
    textureAssignment?.getText(sourceFile) ===
      'this.textureLoader = new TextureLoader( this.options.manager );',
    'transformed Three GLTFParser TextureLoader assignment shape drift'
  )
}

export function transformThreeGltfProductionSource(source) {
  const spec = PINNED_PRODUCTION_VENDORS.three
  assert(
    sha256(source) === spec.gltfLoaderSha256,
    `Three GLTFLoader module SHA-256 does not match pinned ${spec.packageName} ${spec.version}`
  )
  const sourceFile = parseJavaScript(source, 'pinned Three GLTFLoader module')
  const shape = threeGltfInputShape(source, sourceFile)
  const output = applyReplacements(
    source,
    [
      {
        start: shape.textureSelection.getStart(sourceFile),
        end: shape.textureSelection.end,
        text: 'this.textureLoader = new TextureLoader( this.options.manager );',
      },
      {
        start: shape.assetCheck.getStart(sourceFile),
        end: shape.assetCheck.end,
        text: `${THREE_GLTF_URI_GUARD_SOURCE}\n\n\t\t${shape.assetCheck.getText(sourceFile)}`,
      },
    ],
    'Three GLTFLoader module'
  )
  assertThreeGltfProductionOutput(output)
  return output
}

export function assertVendorPackageMetadata(spec, packageSource) {
  assert(
    sha256(packageSource) === spec.packageSha256,
    `${spec.packageName} package.json SHA-256 drift`
  )
  let metadata
  try {
    metadata = JSON.parse(packageSource)
  } catch (error) {
    fail(
      `${spec.packageName} package.json is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  assert(metadata.name === spec.packageName, `${spec.packageName} package name drift`)
  assert(metadata.version === spec.version, `${spec.packageName} version drift`)
  assert(metadata.type === 'module', `${spec.packageName} package type must be module`)
  assert(metadata.module === spec.moduleExport, `${spec.packageName} module entry drift`)
  assert(
    metadata.exports?.['.']?.import === spec.importExport,
    `${spec.packageName} import export entry drift`
  )
}

export function assertProductionVendorDependencyPins(packageSource, lockSource) {
  let packageMetadata
  try {
    packageMetadata = JSON.parse(packageSource)
  } catch (error) {
    fail(`root package.json is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsedLock = ts.parseConfigFileTextToJson('bun.lock', lockSource)
  assert(
    !parsedLock.error,
    `bun.lock is invalid: ${
      parsedLock.error
        ? ts.flattenDiagnosticMessageText(parsedLock.error.messageText, '\n')
        : '<unknown>'
    }`
  )
  const lock = parsedLock.config
  assert(lock?.lockfileVersion === 1, 'bun.lock lockfileVersion must be 1')
  const workspaceDependencies = lock?.workspaces?.['']?.dependencies
  for (const spec of Object.values(PINNED_PRODUCTION_VENDORS)) {
    assert(
      packageMetadata.dependencies?.[spec.packageName] === spec.version,
      `root package.json must pin ${spec.packageName} exactly to ${spec.version}`
    )
    assert(
      workspaceDependencies?.[spec.packageName] === spec.version,
      `bun.lock workspace must pin ${spec.packageName} exactly to ${spec.version}`
    )
    assert(
      lock?.packages?.[spec.packageName]?.[0] === `${spec.packageName}@${spec.version}`,
      `bun.lock resolution drift for ${spec.packageName}`
    )
  }
}

export function verifyPinnedProductionVendorInstallation(rootDirectory) {
  assertProductionVendorDependencyPins(
    readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'),
    readFileSync(resolve(rootDirectory, 'bun.lock'), 'utf8')
  )
  for (const spec of Object.values(PINNED_PRODUCTION_VENDORS)) {
    const packageSource = readFileSync(resolve(rootDirectory, spec.packagePath), 'utf8')
    assertVendorPackageMetadata(spec, packageSource)
    const moduleSource = readFileSync(resolve(rootDirectory, spec.modulePath), 'utf8')
    assert(
      sha256(moduleSource) === spec.moduleSha256,
      `${spec.packageName} installed module SHA-256 drift`
    )
  }
  const three = PINNED_PRODUCTION_VENDORS.three
  const threeCoreSource = readFileSync(resolve(rootDirectory, three.coreModulePath), 'utf8')
  assert(
    sha256(threeCoreSource) === three.coreModuleSha256,
    `${three.packageName} installed core module SHA-256 drift`
  )
  const threeGltfSource = readFileSync(resolve(rootDirectory, three.gltfLoaderPath), 'utf8')
  assert(
    sha256(threeGltfSource) === three.gltfLoaderSha256,
    `${three.packageName} installed GLTFLoader module SHA-256 drift`
  )
}

function cleanModuleId(moduleId) {
  return moduleId.split('?', 1)[0].replaceAll('\\', '/')
}

export function productionVendorBoundaryPlugin(rootDirectory) {
  const spark = PINNED_PRODUCTION_VENDORS.spark
  const rapier = PINNED_PRODUCTION_VENDORS.rapier
  const three = PINNED_PRODUCTION_VENDORS.three
  const transforms = new Map([
    [
      cleanModuleId(resolve(rootDirectory, spark.modulePath)),
      { name: 'spark', transform: transformSparkProductionSource },
    ],
    [
      cleanModuleId(resolve(rootDirectory, rapier.modulePath)),
      { name: 'rapier', transform: transformRapierProductionSource },
    ],
    [
      cleanModuleId(resolve(rootDirectory, three.coreModulePath)),
      { name: 'three-core', transform: transformThreeCoreProductionSource },
    ],
    [
      cleanModuleId(resolve(rootDirectory, three.gltfLoaderPath)),
      { name: 'three-gltf', transform: transformThreeGltfProductionSource },
    ],
  ])
  const transformCounts = new Map([...transforms.values()].map(({ name }) => [name, 0]))

  return {
    name: 'crebain-production-vendor-boundary',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      verifyPinnedProductionVendorInstallation(rootDirectory)
    },
    transform(source, moduleId) {
      const vendorTransform = transforms.get(cleanModuleId(moduleId))
      if (!vendorTransform) return null
      const nextCount = (transformCounts.get(vendorTransform.name) ?? 0) + 1
      assert(nextCount === 1, `${vendorTransform.name} module was transformed more than once`)
      transformCounts.set(vendorTransform.name, nextCount)
      return { code: vendorTransform.transform(source), map: null }
    },
    buildEnd(error) {
      if (error) return
      for (const [vendor, count] of transformCounts) {
        assert(count === 1, `${vendor} module transform count must be exactly 1, got ${count}`)
      }
    },
  }
}
