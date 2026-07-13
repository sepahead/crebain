#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLANT_FRAME_CORPUS_PATH,
  PLANT_FRAME_MANIFEST_PATH,
  PlantFrameConventionError,
  sha256Hex,
  transformVelocity,
  verifyPlantFrameConventions,
} from './lib/plant-frame-conventions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestBytes = readFileSync(resolve(ROOT, PLANT_FRAME_MANIFEST_PATH))
const corpusBytes = readFileSync(resolve(ROOT, PLANT_FRAME_CORPUS_PATH))
const manifestDocument = JSON.parse(manifestBytes.toString('utf8'))
const corpusText = corpusBytes.toString('utf8')

function serializeManifest(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
}

function mutateManifest(mutator) {
  const document = structuredClone(manifestDocument)
  mutator(document)
  return serializeManifest(document)
}

function mutateCorpusRow(text, caseId, column, value) {
  const lines = text.slice(0, -1).split('\n')
  const header = lines[0].split('\t')
  const columnIndex = header.indexOf(column)
  if (columnIndex < 0) throw new Error(`Self-test column not found: ${column}`)
  const rowIndex = lines.findIndex((line, index) => index > 0 && line.split('\t')[0] === caseId)
  if (rowIndex < 0) throw new Error(`Self-test case not found: ${caseId}`)
  const fields = lines[rowIndex].split('\t')
  fields[columnIndex] = value
  lines[rowIndex] = fields.join('\t')
  return `${lines.join('\n')}\n`
}

function removeCorpusRoute(text, fromFrame, toFrame) {
  const prefix = `${fromFrame}__to__${toFrame}__`
  const lines = text.slice(0, -1).split('\n')
  return `${lines.filter((line, index) => index === 0 || !line.startsWith(prefix)).join('\n')}\n`
}

function duplicateCorpusCase(text, caseId) {
  const line = text
    .slice(0, -1)
    .split('\n')
    .find((candidate) => candidate.startsWith(`${caseId}\t`))
  if (line === undefined) throw new Error(`Self-test case not found: ${caseId}`)
  return `${text}${line}\n`
}

function manifestForCorpus(text) {
  return mutateManifest((document) => {
    document.golden_corpus.sha256 = sha256Hex(Buffer.from(text))
  })
}

let negativeCases = 0

function expectFailure(id, expectedCode, operation) {
  let failure = null
  try {
    operation()
  } catch (error) {
    failure = error
  }
  if (failure === null) throw new Error(`${id}: invalid in-memory mutation was accepted`)
  if (!(failure instanceof PlantFrameConventionError)) {
    throw new Error(
      `${id}: unexpected error type: ${failure instanceof Error ? failure.message : failure}`
    )
  }
  if (failure.code !== expectedCode) {
    throw new Error(
      `${id}: expected code '${expectedCode}', got '${failure.code}': ${failure.message}`
    )
  }
  negativeCases += 1
}

const positive = verifyPlantFrameConventions({ manifestBytes, corpusBytes })

const pureInput = [1.25, -2.5, 3.75]
const pureOutput = transformVelocity({
  fromFrame: 'local_enu',
  toFrame: 'local_ned',
  units: 'm/s',
  vector: pureInput,
})
if (pureOutput.join(',') !== '-2.5,1.25,-3.75') {
  throw new Error(`Pure transform produced an unexpected result: ${pureOutput.join(',')}`)
}
if (pureInput.join(',') !== '1.25,-2.5,3.75' || pureOutput === pureInput) {
  throw new Error('Pure transform mutated or aliased its input')
}

const signedZeroOutput = transformVelocity({
  fromFrame: 'body_flu',
  toFrame: 'body_frd',
  units: 'm/s',
  vector: [-0, 0, -0],
})
if (!signedZeroOutput.every((value) => Object.is(value, 0))) {
  throw new Error('Pure transform did not canonicalize every signed zero to positive zero')
}

expectFailure('wrong-zero-representation', 'manifest_schema', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.zero_representation = 'preserve_sign'
    }),
    corpusBytes,
  })
})

expectFailure('wrong-number-encoding', 'manifest_schema', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.number_encoding = 'arbitrary_json_number'
    }),
    corpusBytes,
  })
})

expectFailure('missing-frame-instance-proof', 'manifest_schema', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.frame_instance_requirement.enforcement = 'assumed_from_axis_label'
    }),
    corpusBytes,
  })
})

expectFailure('negative-zero-corpus-value', 'corpus_number', () => {
  const alteredCorpus = mutateCorpusRow(
    corpusText,
    'local_enu__to__local_enu__basis_x',
    'input_y',
    '-0'
  )
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('underflow-alias-with-matching-hash', 'corpus_number', () => {
  const alteredCorpus = mutateCorpusRow(
    corpusText,
    'local_enu__to__local_enu__basis_x',
    'input_y',
    `0.${'0'.repeat(400)}1`
  )
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('rounding-alias-with-matching-hash', 'corpus_number', () => {
  const alteredCorpus = mutateCorpusRow(
    corpusText,
    'local_enu__to__local_enu__asymmetric_signed',
    'input_x',
    '1.5000000000000001'
  )
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('unknown-transform-route', 'unknown_route', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.transform_routes.push({
        from: 'local_enu',
        to: 'body_flu',
        operation: 'identity',
      })
    }),
    corpusBytes,
  })
})

expectFailure('duplicate-transform-route', 'duplicate_route', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.transform_routes.push(structuredClone(document.transform_routes[0]))
    }),
    corpusBytes,
  })
})

expectFailure('missing-transform-route', 'missing_route', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.transform_routes = document.transform_routes.filter(
        (route) => !(route.from === 'local_enu' && route.to === 'local_ned')
      )
    }),
    corpusBytes,
  })
})

expectFailure('duplicate-rejected-route', 'duplicate_route', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.rejected_routes.push(structuredClone(document.rejected_routes[0]))
    }),
    corpusBytes,
  })
})

expectFailure('missing-rejected-route', 'missing_route', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.rejected_routes.pop()
    }),
    corpusBytes,
  })
})

expectFailure('hash-mismatch', 'hash_mismatch', () => {
  verifyPlantFrameConventions({
    manifestBytes: mutateManifest((document) => {
      document.golden_corpus.sha256 = '0'.repeat(64)
    }),
    corpusBytes,
  })
})

expectFailure('altered-output-with-matching-hash', 'altered_output', () => {
  const alteredCorpus = mutateCorpusRow(
    corpusText,
    'local_enu__to__local_ned__asymmetric_signed',
    'expected_x',
    '-2.25'
  )
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('missing-corpus-route-with-matching-hash', 'missing_corpus_route', () => {
  const alteredCorpus = removeCorpusRoute(corpusText, 'body_frd', 'body_frd')
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('duplicate-corpus-case-with-matching-hash', 'duplicate_case', () => {
  const alteredCorpus = duplicateCorpusCase(corpusText, 'body_flu__to__body_frd__basis_y')
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('attitude-required-corpus-route', 'attitude_required', () => {
  let alteredCorpus = mutateCorpusRow(
    corpusText,
    'local_enu__to__local_enu__basis_x',
    'case_id',
    'local_enu__to__body_flu__basis_x'
  )
  alteredCorpus = mutateCorpusRow(
    alteredCorpus,
    'local_enu__to__body_flu__basis_x',
    'to_frame',
    'body_flu'
  )
  verifyPlantFrameConventions({
    manifestBytes: manifestForCorpus(alteredCorpus),
    corpusBytes: Buffer.from(alteredCorpus),
  })
})

expectFailure('attitude-required-pure-transform', 'attitude_required', () => {
  transformVelocity({
    fromFrame: 'local_enu',
    toFrame: 'body_flu',
    units: 'm/s',
    vector: [1, 2, 3],
  })
})

expectFailure('unsupported-units', 'unsupported_units', () => {
  transformVelocity({
    fromFrame: 'body_flu',
    toFrame: 'body_frd',
    units: 'ft/s',
    vector: [1, 2, 3],
  })
})

expectFailure('unknown-frame', 'unknown_frame', () => {
  transformVelocity({
    fromFrame: 'map',
    toFrame: 'local_enu',
    units: 'm/s',
    vector: [1, 2, 3],
  })
})

expectFailure('duplicate-json-key', 'duplicate_manifest_key', () => {
  const duplicateKeyManifest = manifestBytes
    .toString('utf8')
    .replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,')
  verifyPlantFrameConventions({
    manifestBytes: Buffer.from(duplicateKeyManifest),
    corpusBytes,
  })
})

console.log(
  `OK: plant frame convention self-test passed (${positive.goldenCases} positive golden cases; ` +
    `${negativeCases} fail-closed in-memory mutations)`
)
