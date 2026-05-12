import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const PACKAGE = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8')) as { scripts: Record<string, string> }
const WORKFLOW = readFileSync(`${process.cwd()}/.github/workflows/ci.yml`, 'utf8')
const README = readFileSync(`${process.cwd()}/README.md`, 'utf8')
const SECURITY = readFileSync(`${process.cwd()}/SECURITY.md`, 'utf8')
const MODEL_README = readFileSync(`${process.cwd()}/public/models/README.md`, 'utf8')
const RELEASE_ACCEPTANCE = readFileSync(`${process.cwd()}/docs/RELEASE_ACCEPTANCE.md`, 'utf8')
const MODEL_CONTRACTS = readFileSync(`${process.cwd()}/docs/MODEL_CONTRACTS.md`, 'utf8')
const MANUAL_SMOKE = readFileSync(`${process.cwd()}/docs/MANUAL_SMOKE_TEST.md`, 'utf8')
const RELEASE_EVIDENCE = readFileSync(`${process.cwd()}/docs/RELEASE_EVIDENCE.md`, 'utf8')
const MANUAL_SMOKE_WORKFLOW = readFileSync(`${process.cwd()}/.windsurf/workflows/manual-smoke-test.md`, 'utf8')
const APP = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')
const PERFORMANCE_PANEL = readFileSync(`${process.cwd()}/src/components/PerformancePanel.tsx`, 'utf8')
const CREBAIN_VIEWER = readFileSync(`${process.cwd()}/src/components/CrebainViewer.tsx`, 'utf8')

describe('CI workflow', () => {
  it('uses package validation scripts for frontend and backend checks', () => {
    for (const script of ['validate', 'check:rust', 'clippy:rust', 'test:rust']) {
      expect(PACKAGE.scripts[script]).toBeTruthy()
      expect(WORKFLOW).toContain(`bun run ${script}`)
    }
  })

  it('installs the toolchains required by package scripts', () => {
    expect(WORKFLOW).toContain('oven-sh/setup-bun@v2')
    expect(WORKFLOW).toContain('dtolnay/rust-toolchain@stable')
  })

  it('keeps full validation composed from the package scripts documented in README', () => {
    for (const script of ['validate', 'check:rust', 'test:rust', 'clippy:rust']) {
      expect(PACKAGE.scripts['validate:all']).toContain(`bun run ${script}`)
      expect(README).toContain(`bun run ${script}`)
    }
  })

  it('keeps the stabilization roadmap aligned with completed validation work', () => {
    for (const item of [
      'Guidance controller loop tests',
      'End-to-end detection/fusion smoke tests',
      'CI backend alignment to package scripts',
      'Release acceptance matrix, model contracts, security threat model, and manual smoke checklist',
      'Executable negative guard tests for native detection, model path, scene path, and transport topic boundaries',
    ]) {
      expect(README).toContain(`- [x] ${item}`)
    }
  })

  it('keeps release readiness artifacts linked from README', () => {
    for (const artifact of [
      'docs/RELEASE_ACCEPTANCE.md',
      'docs/MODEL_CONTRACTS.md',
      'docs/MANUAL_SMOKE_TEST.md',
      'docs/RELEASE_EVIDENCE.md',
      'SECURITY.md',
    ]) {
      expect(README).toContain(artifact)
    }

    expect(RELEASE_ACCEPTANCE).toContain('Release Candidate Gate')
    expect(MODEL_CONTRACTS).toContain('Required Model Record')
    expect(MANUAL_SMOKE).toContain('Environment Record')
    expect(RELEASE_EVIDENCE).toContain('Current Candidate')
    expect(MANUAL_SMOKE_WORKFLOW).toContain('docs/MANUAL_SMOKE_TEST.md')
  })

  it('records CI validation summaries for release evidence review', () => {
    expect(WORKFLOW).toContain('GITHUB_STEP_SUMMARY')
    expect(WORKFLOW).toContain('frontend-validation.log')
    expect(WORKFLOW).toContain('rust-check.log')
    expect(WORKFLOW).toContain('rust-clippy.log')
    expect(WORKFLOW).toContain('rust-test.log')
    expect(RELEASE_EVIDENCE).toContain('GitHub Actions run')
  })

  it('keeps model documentation aligned with model contracts', () => {
    expect(MODEL_README).toContain('../../docs/MODEL_CONTRACTS.md')
    expect(MODEL_README).toContain('CREBAIN_MLX_MODEL')
    expect(MODEL_CONTRACTS).toContain('.safetensors')
    expect(RELEASE_ACCEPTANCE).toContain('MLX safetensors inputs')
    expect(SECURITY).toContain('MLX `.safetensors`')
    for (const backend of ['Native CoreML', 'ONNX Runtime Native', 'CUDA / TensorRT', 'MLX']) {
      expect(MODEL_CONTRACTS).toContain(backend)
    }
  })

  it('keeps security threat model aligned with release acceptance boundaries', () => {
    for (const boundary of [
      'Model loading',
      'Scene persistence',
      'Native detection IPC',
      'ROS bridge',
      'Zenoh transport',
      'Tauri commands/events',
    ]) {
      expect(SECURITY).toContain(boundary)
    }

    for (const phrase of ['model path', 'scene file', 'transport topic', 'structured error payloads']) {
      expect(RELEASE_ACCEPTANCE.toLowerCase()).toContain(phrase)
    }
  })

  it('keeps diagnostics UI from claiming unverified backend, model, network, or crypto readiness', () => {
    expect(APP).toContain('TAURI_COMMANDS.detection.systemInfo')
    expect(APP).toContain('backend={systemInfo.backend}')
    expect(APP).toContain('backendDetail={systemInfo.mode')
    expect(APP).not.toContain('backend="CoreML (Metal/Neural Engine)"')

    expect(PERFORMANCE_PANEL).toContain("backend = 'Unknown'")
    expect(PERFORMANCE_PANEL).toContain('backendDetail')
    expect(PERFORMANCE_PANEL).not.toContain('Metal / Neural Engine')

    expect(CREBAIN_VIEWER).toContain('VERTRAG OFFEN')
    expect(CREBAIN_VIEWER).toContain('NICHT KONFIG.')
    expect(CREBAIN_VIEWER).toContain('SIM POS')
    expect(CREBAIN_VIEWER).not.toContain("const networkStatus = 'VERBUNDEN'")
    expect(CREBAIN_VIEWER).not.toContain('AES-256')
    expect(CREBAIN_VIEWER).not.toContain('<span className="text-[#808080]">YOLOv8s</span>')

    expect(README).toContain('MLX is experimental, opt-in')
    expect(README).toContain('requires external model-contract validation before release claims')
    expect(README).not.toContain('zero-output scaffold')
    expect(README).not.toContain('scaffolded zero-output detections')
  })
})
