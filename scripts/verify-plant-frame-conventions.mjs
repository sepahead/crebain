#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLANT_FRAME_CORPUS_PATH,
  PLANT_FRAME_MANIFEST_PATH,
  verifyPlantFrameConventions,
} from './lib/plant-frame-conventions.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.argv.length !== 2) {
  throw new Error('verify-plant-frame-conventions.mjs does not accept arguments')
}

const result = verifyPlantFrameConventions({
  manifestBytes: readFileSync(resolve(ROOT, PLANT_FRAME_MANIFEST_PATH)),
  corpusBytes: readFileSync(resolve(ROOT, PLANT_FRAME_CORPUS_PATH)),
})

console.log(
  `OK: plant frame conventions v${result.schemaVersion} verified ` +
    `(${result.frames} frames; ${result.transformRoutes} transform routes; ` +
    `${result.rejectedRoutes} attitude-required routes; ${result.goldenCases} golden cases; ` +
    `SHA-256 ${result.corpusSha256})`
)
