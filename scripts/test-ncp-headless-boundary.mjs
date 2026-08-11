#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertHeadlessManifestBoundary,
  assertMetadataDependencyBoundary,
  assertNoImplicitBuildScript,
  assertHeadlessRustBoundary,
  assertBridgeDelegationValidationOrder,
} from './check-ncp-headless-boundary.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = readFileSync(resolve(ROOT, 'src-tauri/crates/ncp-headless/Cargo.toml'), 'utf8')
const LIBRARY = readFileSync(resolve(ROOT, 'src-tauri/crates/ncp-headless/src/lib.rs'), 'utf8')
const BRIDGE = readFileSync(resolve(ROOT, 'src-tauri/src/ncp/mod.rs'), 'utf8')

function expectFailure(id, operation, expected) {
  let failure = null
  try {
    operation()
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure === null) throw new Error(`${id}: invalid mutation was accepted`)
  if (!failure.includes(expected)) {
    throw new Error(`${id}: expected '${expected}', got '${failure}'`)
  }
}

expectFailure(
  'direct-tauri-dependency',
  () =>
    assertHeadlessManifestBoundary(
      MANIFEST.replace('[dependencies]', '[dependencies]\ntauri = "2"')
    ),
  'runtime dependency set'
)
expectFailure(
  'default-network-feature',
  () => assertHeadlessManifestBoundary(MANIFEST.replace('default = []', 'default = ["ncp"]')),
  'default feature set'
)
expectFailure(
  'ungated-binary',
  () =>
    assertHeadlessManifestBoundary(
      MANIFEST.replace('required-features = ["ncp"]', 'required-features = []')
    ),
  'binary feature gate'
)
expectFailure(
  'build-dependency',
  () => assertHeadlessManifestBoundary(`${MANIFEST}\n[build-dependencies]\ntauri-build = "2"\n`),
  'build dependencies are forbidden'
)
expectFailure(
  'explicit-build-script',
  () =>
    assertHeadlessManifestBoundary(MANIFEST.replace('[package]', '[package]\nbuild = "build.rs"')),
  'custom package build scripts are forbidden'
)
expectFailure(
  'implicit-build-script',
  () => assertNoImplicitBuildScript(['Cargo.toml', 'build.rs', 'src']),
  'implicit package build.rs is forbidden'
)
expectFailure(
  'aliased-development-dependency',
  () =>
    assertMetadataDependencyBoundary([
      ...['ncp-core', 'ncp-zenoh', 'serde', 'serde_json', 'tokio', 'zenoh'].map((name) => ({
        kind: null,
        name,
        optional: true,
        rename: null,
        target: null,
      })),
      {
        kind: 'dev',
        name: 'tauri',
        optional: false,
        rename: 'tempfile',
        target: null,
      },
    ]),
  'dependency aliases are forbidden'
)
expectFailure(
  'crebain-library-import',
  () => assertHeadlessRustBoundary('mutation.rs', 'use crebain_lib::ncp;'),
  "forbidden source capability 'crebain_lib'"
)
expectFailure(
  'tauri-import',
  () => assertHeadlessRustBoundary('mutation.rs', 'use tauri::Manager;'),
  "forbidden source capability 'tauri'"
)
expectFailure(
  'action-subscription',
  () => assertHeadlessRustBoundary('mutation.rs', 'bridge.subscribe_commands().await;'),
  "forbidden source capability 'subscribe_commands'"
)
expectFailure(
  'unsafe-source',
  () => assertHeadlessRustBoundary('mutation.rs', 'unsafe { core::hint::unreachable_unchecked() }'),
  'unsafe Rust'
)
expectFailure(
  'quiet-development-connector',
  () =>
    assertHeadlessRustBoundary(
      'src-tauri/crates/ncp-headless/src/lib.rs',
      LIBRARY.replace(
        'ZenohBus::with_config(self.config.clone(), keys)',
        'ZenohBus::open_realm(keys)'
      )
    ),
  "forbidden source capability 'open_realm'"
)
expectFailure(
  'missing-strict-snapshot-validation',
  () =>
    assertHeadlessRustBoundary(
      'src-tauri/crates/ncp-headless/src/lib.rs',
      LIBRARY.replace(
        'validate_secure_client_config(&secure_config.config)?;',
        'drop(&secure_config.config);'
      )
    ),
  'must validate exactly one bounded secure-config snapshot before opening'
)
expectFailure(
  'open-lock-before-validation',
  () =>
    assertBridgeDelegationValidationOrder(
      BRIDGE.replace(
        'validate_session_id(session_id)?;\n        validate_model_name(model)?;\n        let lifecycle_lock = self.lifecycle_lock(session_id)?;',
        'let lifecycle_lock = self.lifecycle_lock(session_id)?;\n        validate_session_id(session_id)?;\n        validate_model_name(model)?;'
      )
    ),
  'must perform session ID validation before lifecycle locking'
)
expectFailure(
  'step-lock-before-validation',
  () =>
    assertBridgeDelegationValidationOrder(
      BRIDGE.replace(
        'validate_session_id(session_id)?;\n        validate_step_inputs(drive_pa, advance_ms)?;\n        let lifecycle_lock = self.lifecycle_lock(session_id)?;',
        'let lifecycle_lock = self.lifecycle_lock(session_id)?;\n        validate_session_id(session_id)?;\n        validate_step_inputs(drive_pa, advance_ms)?;'
      )
    ),
  'must perform session ID validation before lifecycle locking'
)
expectFailure(
  'close-lock-before-validation',
  () =>
    assertBridgeDelegationValidationOrder(
      BRIDGE.replace(
        'validate_session_id(session_id)?;\n        let lifecycle_lock = self.lifecycle_lock(session_id)?;',
        'let lifecycle_lock = self.lifecycle_lock(session_id)?;\n        validate_session_id(session_id)?;'
      )
    ),
  'must perform session ID validation before lifecycle locking'
)

assertHeadlessManifestBoundary(MANIFEST)
assertHeadlessRustBoundary(
  'allowed.rs',
  '// tauri crebain_lib subscribe_commands\nconst NOTE: &str = "ort image CommandFrame";\nfn safe() {}'
)
assertBridgeDelegationValidationOrder(BRIDGE)

console.log(
  'OK: headless NCP boundary self-test passed (16 fail-closed mutations, 3 valid controls)'
)
