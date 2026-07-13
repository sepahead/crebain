import { createHash } from 'node:crypto'

export const PLANT_FRAME_CONVENTIONS_VERSION = 1
export const PLANT_FRAME_MANIFEST_PATH = 'docs/baselines/plant-frame-conventions-v1.json'
export const PLANT_FRAME_CORPUS_PATH = 'docs/baselines/plant-frame-golden-v1.tsv'
export const VELOCITY_UNITS = 'm/s'
export const CORPUS_NUMBER_ENCODING =
  'shortest_round_trip_plain_decimal_max_3_integer_6_fraction_digits'

const FRAME_SPECS = new Map([
  ['local_enu', { domain: 'local', axes: ['east', 'north', 'up'] }],
  ['local_ned', { domain: 'local', axes: ['north', 'east', 'down'] }],
  ['body_flu', { domain: 'body', axes: ['forward', 'left', 'up'] }],
  ['body_frd', { domain: 'body', axes: ['forward', 'right', 'down'] }],
])

const TRANSFORM_ROUTE_SPECS = new Map([
  ['local_enu->local_enu', 'identity'],
  ['local_enu->local_ned', 'swap_xy_negate_z'],
  ['local_ned->local_enu', 'swap_xy_negate_z'],
  ['local_ned->local_ned', 'identity'],
  ['body_flu->body_flu', 'identity'],
  ['body_flu->body_frd', 'keep_x_negate_yz'],
  ['body_frd->body_flu', 'keep_x_negate_yz'],
  ['body_frd->body_frd', 'identity'],
])

const REJECTED_ROUTE_SPECS = new Map([
  ['local_enu->body_flu', 'attitude_required'],
  ['local_enu->body_frd', 'attitude_required'],
  ['local_ned->body_flu', 'attitude_required'],
  ['local_ned->body_frd', 'attitude_required'],
  ['body_flu->local_enu', 'attitude_required'],
  ['body_flu->local_ned', 'attitude_required'],
  ['body_frd->local_enu', 'attitude_required'],
  ['body_frd->local_ned', 'attitude_required'],
])

const REQUIRED_EXCLUSIONS = new Set([
  'frame instance identity',
  'attitude',
  'quaternions',
  'yaw',
  'points',
  'translation',
  'covariance',
  'Three.js',
  'time',
  'profile selection',
])

const CORPUS_HEADER = [
  'case_id',
  'from_frame',
  'to_frame',
  'units',
  'vector_case',
  'input_x',
  'input_y',
  'input_z',
  'expected_x',
  'expected_y',
  'expected_z',
]
const VECTOR_CASES = new Set(['basis_x', 'basis_y', 'basis_z', 'asymmetric_signed'])
const BASIS_VECTORS = new Map([
  ['basis_x', [1, 0, 0]],
  ['basis_y', [0, 1, 0]],
  ['basis_z', [0, 0, 1]],
])
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/

export class PlantFrameConventionError extends Error {
  constructor(code, message) {
    super(`Plant frame convention verification failed [${code}]: ${message}`)
    this.name = 'PlantFrameConventionError'
    this.code = code
  }
}

function fail(code, message) {
  throw new PlantFrameConventionError(code, message)
}

function assert(condition, code, message) {
  if (!condition) fail(code, message)
}

function routeKey(fromFrame, toFrame) {
  return `${fromFrame}->${toFrame}`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, requiredKeys, label) {
  assert(isPlainObject(value), 'manifest_schema', `${label} must be an object`)
  const actual = Object.keys(value)
  const expected = new Set(requiredKeys)
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key))
  const unknown = actual.filter((key) => !expected.has(key))
  assert(
    missing.length === 0 && unknown.length === 0,
    'manifest_schema',
    `${label} keys mismatch; missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'}`
  )
}

function assertExactArray(actual, expected, label) {
  assert(Array.isArray(actual), 'manifest_schema', `${label} must be an array`)
  assert(actual.length === expected.length, 'manifest_schema', `${label} length is not canonical`)
  for (let index = 0; index < expected.length; index += 1) {
    assert(
      actual[index] === expected[index],
      'manifest_schema',
      `${label}[${index}] must be ${expected[index]}`
    )
  }
}

function toBytes(source, label) {
  if (typeof source === 'string') return new TextEncoder().encode(source)
  assert(source instanceof Uint8Array, 'input_type', `${label} must be a string or Uint8Array`)
  return source
}

function decodeUtf8(source, label) {
  const bytes = toBytes(source, label)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    fail(
      'invalid_utf8',
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// JSON.parse accepts repeated object keys. This syntax walk rejects them before
// the parsed value is trusted, while JSON.parse remains the grammar authority.
function assertNoDuplicateJsonKeys(text) {
  let cursor = 0

  function skipWhitespace() {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
  }

  function parseStringToken() {
    assert(text[cursor] === '"', 'manifest_json', 'expected a JSON string')
    const start = cursor
    cursor += 1
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (text[cursor] === '"') {
        cursor += 1
        return JSON.parse(text.slice(start, cursor))
      }
      cursor += 1
    }
    fail('manifest_json', 'unterminated JSON string')
  }

  function parseValue() {
    skipWhitespace()
    const token = text[cursor]
    if (token === '{') {
      parseObject()
      return
    }
    if (token === '[') {
      parseArray()
      return
    }
    if (token === '"') {
      parseStringToken()
      return
    }
    const match = text
      .slice(cursor)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    assert(match !== null, 'manifest_json', `unexpected JSON token at byte ${cursor}`)
    cursor += match[0].length
  }

  function parseObject() {
    cursor += 1
    skipWhitespace()
    const keys = new Set()
    if (text[cursor] === '}') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      skipWhitespace()
      const key = parseStringToken()
      assert(!keys.has(key), 'duplicate_manifest_key', `duplicate JSON object key '${key}'`)
      keys.add(key)
      skipWhitespace()
      assert(text[cursor] === ':', 'manifest_json', `missing ':' after JSON key '${key}'`)
      cursor += 1
      parseValue()
      skipWhitespace()
      if (text[cursor] === '}') {
        cursor += 1
        return
      }
      assert(text[cursor] === ',', 'manifest_json', `missing ',' after JSON key '${key}'`)
      cursor += 1
    }
    fail('manifest_json', 'unterminated JSON object')
  }

  function parseArray() {
    cursor += 1
    skipWhitespace()
    if (text[cursor] === ']') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      parseValue()
      skipWhitespace()
      if (text[cursor] === ']') {
        cursor += 1
        return
      }
      assert(text[cursor] === ',', 'manifest_json', 'missing comma in JSON array')
      cursor += 1
    }
    fail('manifest_json', 'unterminated JSON array')
  }

  parseValue()
  skipWhitespace()
  assert(cursor === text.length, 'manifest_json', 'unexpected data after JSON document')
}

function assertExactVocabulary(actual, expected, label) {
  assert(Array.isArray(actual), 'manifest_schema', `${label} must be an array`)
  const actualSet = new Set(actual)
  assert(actualSet.size === actual.length, 'duplicate_exclusion', `${label} contains duplicates`)
  const missing = [...expected].filter((value) => !actualSet.has(value))
  const unknown = [...actualSet].filter((value) => !expected.has(value))
  assert(
    missing.length === 0 && unknown.length === 0,
    'manifest_schema',
    `${label} mismatch; missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'}`
  )
}

function verifyFrames(frames) {
  assert(Array.isArray(frames), 'manifest_schema', 'frames must be an array')
  const seen = new Set()
  for (const [index, frame] of frames.entries()) {
    const label = `frames[${index}]`
    assertExactKeys(frame, ['id', 'domain', 'axes'], label)
    assert(typeof frame.id === 'string', 'manifest_schema', `${label}.id must be a string`)
    assert(!seen.has(frame.id), 'duplicate_frame', `duplicate frame '${frame.id}'`)
    seen.add(frame.id)
    const expected = FRAME_SPECS.get(frame.id)
    assert(expected !== undefined, 'unknown_frame', `unknown manifest frame '${frame.id}'`)
    assert(frame.domain === expected.domain, 'manifest_schema', `${label}.domain is not canonical`)
    assertExactArray(frame.axes, expected.axes, `${label}.axes`)
  }
  const missing = [...FRAME_SPECS.keys()].filter((frame) => !seen.has(frame))
  assert(missing.length === 0, 'missing_frame', `missing frames: ${missing.join(',')}`)
}

function verifyRoutes(routes, expectedRoutes, valueKey, label) {
  assert(Array.isArray(routes), 'manifest_schema', `${label} must be an array`)
  const seen = new Set()
  for (const [index, route] of routes.entries()) {
    assertExactKeys(route, ['from', 'to', valueKey], `${label}[${index}]`)
    const key = routeKey(route.from, route.to)
    assert(!seen.has(key), 'duplicate_route', `duplicate ${label} route '${key}'`)
    seen.add(key)
    const expectedValue = expectedRoutes.get(key)
    assert(expectedValue !== undefined, 'unknown_route', `unknown ${label} route '${key}'`)
    assert(
      route[valueKey] === expectedValue,
      'route_semantics',
      `${label} route '${key}' must use ${valueKey} '${expectedValue}'`
    )
  }
  const missing = [...expectedRoutes.keys()].filter((key) => !seen.has(key))
  assert(missing.length === 0, 'missing_route', `missing ${label} routes: ${missing.join(',')}`)
}

export function sha256Hex(source) {
  return createHash('sha256').update(toBytes(source, 'hash input')).digest('hex')
}

export function parsePlantFrameManifest(source) {
  const text = decodeUtf8(source, 'plant frame manifest')
  assert(
    !text.startsWith('\uFEFF'),
    'manifest_json',
    'manifest must not start with a byte-order mark'
  )
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    fail(
      'manifest_json',
      `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  assertNoDuplicateJsonKeys(text)
  assertExactKeys(
    manifest,
    [
      'schema_version',
      'corpus_id',
      'scope',
      'units',
      'zero_representation',
      'number_encoding',
      'frame_instance_requirement',
      'golden_corpus',
      'frames',
      'transform_routes',
      'rejected_routes',
      'explicit_exclusions',
    ],
    'manifest'
  )
  assert(
    manifest.schema_version === PLANT_FRAME_CONVENTIONS_VERSION,
    'manifest_schema',
    `schema_version must be ${PLANT_FRAME_CONVENTIONS_VERSION}`
  )
  assert(
    manifest.corpus_id === 'plant-frame-conventions-v1',
    'manifest_schema',
    "corpus_id must be 'plant-frame-conventions-v1'"
  )
  assert(
    manifest.scope === 'velocity_vectors_only',
    'manifest_schema',
    "scope must be 'velocity_vectors_only'"
  )
  assert(
    manifest.units === VELOCITY_UNITS,
    'unsupported_units',
    `units must be '${VELOCITY_UNITS}'`
  )
  assert(
    manifest.zero_representation === 'positive_zero',
    'manifest_schema',
    "zero_representation must be 'positive_zero'"
  )
  assert(
    manifest.number_encoding === CORPUS_NUMBER_ENCODING,
    'manifest_schema',
    `number_encoding must be '${CORPUS_NUMBER_ENCODING}'`
  )
  assertExactKeys(
    manifest.frame_instance_requirement,
    ['local', 'body', 'enforcement'],
    'frame_instance_requirement'
  )
  assert(
    manifest.frame_instance_requirement.local === 'same_tangent_origin_and_datum',
    'manifest_schema',
    "frame_instance_requirement.local must be 'same_tangent_origin_and_datum'"
  )
  assert(
    manifest.frame_instance_requirement.body === 'same_rigid_body_reference_point',
    'manifest_schema',
    "frame_instance_requirement.body must be 'same_rigid_body_reference_point'"
  )
  assert(
    manifest.frame_instance_requirement.enforcement === 'not_carried_caller_must_prove',
    'manifest_schema',
    "frame_instance_requirement.enforcement must be 'not_carried_caller_must_prove'"
  )
  assertExactKeys(manifest.golden_corpus, ['path', 'sha256'], 'golden_corpus')
  assert(
    manifest.golden_corpus.path === PLANT_FRAME_CORPUS_PATH,
    'manifest_schema',
    `golden_corpus.path must be '${PLANT_FRAME_CORPUS_PATH}'`
  )
  assert(
    typeof manifest.golden_corpus.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(manifest.golden_corpus.sha256),
    'manifest_schema',
    'golden_corpus.sha256 must be a lowercase SHA-256 digest'
  )
  verifyFrames(manifest.frames)
  verifyRoutes(manifest.transform_routes, TRANSFORM_ROUTE_SPECS, 'operation', 'transform_routes')
  verifyRoutes(manifest.rejected_routes, REJECTED_ROUTE_SPECS, 'reason', 'rejected_routes')
  assertExactVocabulary(manifest.explicit_exclusions, REQUIRED_EXCLUSIONS, 'explicit_exclusions')
  return deepFreeze(manifest)
}

function parseDecimal(value, label) {
  assert(DECIMAL_PATTERN.test(value), 'corpus_number', `${label} is not a canonical decimal`)
  const parsed = Number(value)
  assert(Number.isFinite(parsed), 'corpus_number', `${label} is not finite`)
  assert(!Object.is(parsed, -0), 'corpus_number', `${label} must not be negative zero`)
  assert(
    String(parsed) === value,
    'corpus_number',
    `${label} is not the shortest round-trip decimal for its value`
  )
  return parsed
}

function vectorsEqual(left, right) {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  )
}

function validateInputCase(vectorCase, input, caseId) {
  const basis = BASIS_VECTORS.get(vectorCase)
  if (basis !== undefined) {
    assert(
      vectorsEqual(input, basis),
      'corpus_case',
      `${caseId} must use canonical input [${basis.join(',')}]`
    )
    return
  }
  assert(
    input.every((value) => value !== 0) &&
      input.some((value) => value > 0) &&
      input.some((value) => value < 0) &&
      new Set(input.map((value) => Math.abs(value))).size === 3,
    'corpus_case',
    `${caseId} must use a nonzero, mixed-sign, asymmetric vector`
  )
}

export function parsePlantFrameCorpus(source) {
  const text = decodeUtf8(source, 'plant frame golden corpus')
  assert(
    !text.startsWith('\uFEFF'),
    'corpus_format',
    'corpus must not start with a byte-order mark'
  )
  assert(!text.includes('\r'), 'corpus_format', 'corpus must use LF line endings')
  assert(text.endsWith('\n'), 'corpus_format', 'corpus must end with a newline')
  const lines = text.slice(0, -1).split('\n')
  assert(lines.length > 1, 'corpus_format', 'corpus must contain a header and rows')
  assertExactArray(lines[0].split('\t'), CORPUS_HEADER, 'corpus header')

  const rows = []
  const seenCaseIds = new Set()
  const routeCases = new Map([...TRANSFORM_ROUTE_SPECS.keys()].map((key) => [key, new Set()]))

  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1
    assert(lines[index].length > 0, 'corpus_format', `line ${lineNumber} is empty`)
    const fields = lines[index].split('\t')
    assert(
      fields.length === CORPUS_HEADER.length,
      'corpus_format',
      `line ${lineNumber} has ${fields.length} columns, expected ${CORPUS_HEADER.length}`
    )
    const [
      caseId,
      fromFrame,
      toFrame,
      units,
      vectorCase,
      inputX,
      inputY,
      inputZ,
      expectedX,
      expectedY,
      expectedZ,
    ] = fields
    assert(!seenCaseIds.has(caseId), 'duplicate_case', `duplicate corpus case '${caseId}'`)
    seenCaseIds.add(caseId)
    assert(
      FRAME_SPECS.has(fromFrame),
      'unknown_frame',
      `${caseId} has unknown from_frame '${fromFrame}'`
    )
    assert(FRAME_SPECS.has(toFrame), 'unknown_frame', `${caseId} has unknown to_frame '${toFrame}'`)
    const key = routeKey(fromFrame, toFrame)
    assert(
      TRANSFORM_ROUTE_SPECS.has(key),
      REJECTED_ROUTE_SPECS.has(key) ? 'attitude_required' : 'unknown_route',
      `${caseId} uses non-transformable route '${key}'`
    )
    assert(
      units === VELOCITY_UNITS,
      'unsupported_units',
      `${caseId} units must be '${VELOCITY_UNITS}'`
    )
    assert(
      VECTOR_CASES.has(vectorCase),
      'corpus_case',
      `${caseId} has unknown vector_case '${vectorCase}'`
    )
    const canonicalCaseId = `${fromFrame}__to__${toFrame}__${vectorCase}`
    assert(caseId === canonicalCaseId, 'corpus_case', `case_id must be '${canonicalCaseId}'`)
    const cases = routeCases.get(key)
    assert(
      !cases.has(vectorCase),
      'duplicate_case',
      `duplicate ${vectorCase} case for route '${key}'`
    )
    cases.add(vectorCase)
    const input = [
      parseDecimal(inputX, `${caseId}.input_x`),
      parseDecimal(inputY, `${caseId}.input_y`),
      parseDecimal(inputZ, `${caseId}.input_z`),
    ]
    const expected = [
      parseDecimal(expectedX, `${caseId}.expected_x`),
      parseDecimal(expectedY, `${caseId}.expected_y`),
      parseDecimal(expectedZ, `${caseId}.expected_z`),
    ]
    validateInputCase(vectorCase, input, caseId)
    rows.push(
      deepFreeze({
        caseId,
        fromFrame,
        toFrame,
        units,
        vectorCase,
        input,
        expected,
      })
    )
  }

  for (const [key, cases] of routeCases) {
    const missingCases = [...VECTOR_CASES].filter((vectorCase) => !cases.has(vectorCase))
    assert(
      missingCases.length === 0,
      'missing_corpus_route',
      `route '${key}' is missing cases: ${missingCases.join(',')}`
    )
  }
  return deepFreeze(rows)
}

function assertVector(vector) {
  assert(Array.isArray(vector), 'invalid_vector', 'vector must be an array')
  assert(vector.length === 3, 'invalid_vector', 'vector must contain exactly three components')
  for (const [index, value] of vector.entries()) {
    assert(Number.isFinite(value), 'invalid_vector', `vector[${index}] must be finite`)
  }
}

function canonicalZero(value) {
  return value === 0 ? 0 : value
}

export function transformVelocity({ fromFrame, toFrame, units, vector }) {
  assert(FRAME_SPECS.has(fromFrame), 'unknown_frame', `unknown source frame '${fromFrame}'`)
  assert(FRAME_SPECS.has(toFrame), 'unknown_frame', `unknown target frame '${toFrame}'`)
  assert(units === VELOCITY_UNITS, 'unsupported_units', `units must be '${VELOCITY_UNITS}'`)
  assertVector(vector)

  const key = routeKey(fromFrame, toFrame)
  if (REJECTED_ROUTE_SPECS.has(key)) {
    fail('attitude_required', `route '${key}' requires an attitude and is outside this corpus`)
  }
  const operation = TRANSFORM_ROUTE_SPECS.get(key)
  assert(operation !== undefined, 'unknown_route', `route '${key}' is not defined`)
  const [x, y, z] = vector
  let output
  if (operation === 'identity') output = [x, y, z]
  else if (operation === 'swap_xy_negate_z') output = [y, x, -z]
  else if (operation === 'keep_x_negate_yz') output = [x, -y, -z]
  else fail('route_semantics', `operation '${operation}' is not implemented`)
  return Object.freeze(output.map(canonicalZero))
}

export function verifyPlantFrameConventions({ manifestBytes, corpusBytes }) {
  const manifest = parsePlantFrameManifest(manifestBytes)
  const actualDigest = sha256Hex(corpusBytes)
  assert(
    actualDigest === manifest.golden_corpus.sha256,
    'hash_mismatch',
    `golden corpus SHA-256 is ${actualDigest}, expected ${manifest.golden_corpus.sha256}`
  )
  const rows = parsePlantFrameCorpus(corpusBytes)
  for (const row of rows) {
    const actual = transformVelocity({
      fromFrame: row.fromFrame,
      toFrame: row.toFrame,
      units: row.units,
      vector: row.input,
    })
    assert(
      vectorsEqual(actual, row.expected),
      'altered_output',
      `${row.caseId} expected [${row.expected.join(',')}], computed [${actual.join(',')}]`
    )
  }
  return deepFreeze({
    schemaVersion: manifest.schema_version,
    zeroRepresentation: manifest.zero_representation,
    numberEncoding: manifest.number_encoding,
    frameInstanceRequirement: manifest.frame_instance_requirement,
    frames: FRAME_SPECS.size,
    transformRoutes: TRANSFORM_ROUTE_SPECS.size,
    rejectedRoutes: REJECTED_ROUTE_SPECS.size,
    goldenCases: rows.length,
    corpusSha256: actualDigest,
  })
}
