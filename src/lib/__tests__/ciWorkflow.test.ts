import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const PACKAGE = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8')) as {
  scripts: Record<string, string>
}
const WORKFLOW = readFileSync(`${process.cwd()}/.github/workflows/ci.yml`, 'utf8')
const RELEASE_WORKFLOW = readFileSync(`${process.cwd()}/.github/workflows/release.yml`, 'utf8')
const DEPENDABOT = readFileSync(`${process.cwd()}/.github/dependabot.yml`, 'utf8')
const WORKFLOW_SOURCES = readdirSync(`${process.cwd()}/.github/workflows`)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => ({
    file,
    source: readFileSync(`${process.cwd()}/.github/workflows/${file}`, 'utf8'),
  }))
const WORKFLOWS = WORKFLOW_SOURCES.map(({ source }) => source).join('\n')
const README = readFileSync(`${process.cwd()}/README.md`, 'utf8')
const SECURITY = readFileSync(`${process.cwd()}/SECURITY.md`, 'utf8')
const MODEL_README = readFileSync(`${process.cwd()}/public/models/README.md`, 'utf8')
const RELEASE_ACCEPTANCE = readFileSync(`${process.cwd()}/docs/RELEASE_ACCEPTANCE.md`, 'utf8')
const MODEL_CONTRACTS = readFileSync(`${process.cwd()}/docs/MODEL_CONTRACTS.md`, 'utf8')
const MANUAL_SMOKE = readFileSync(`${process.cwd()}/docs/MANUAL_SMOKE_TEST.md`, 'utf8')
const RELEASE_EVIDENCE = readFileSync(`${process.cwd()}/docs/RELEASE_EVIDENCE.md`, 'utf8')
const MANUAL_SMOKE_WORKFLOW = readFileSync(
  `${process.cwd()}/.windsurf/workflows/manual-smoke-test.md`,
  'utf8'
)
const APP = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')
const PERFORMANCE_PANEL = readFileSync(
  `${process.cwd()}/src/components/PerformancePanel.tsx`,
  'utf8'
)
const CREBAIN_VIEWER = readFileSync(`${process.cwd()}/src/components/CrebainViewer.tsx`, 'utf8')
const HEADER_BAR = readFileSync(`${process.cwd()}/src/components/viewer/HeaderBar.tsx`, 'utf8')
const DETECTION_PANEL = readFileSync(
  `${process.cwd()}/src/components/viewer/DetectionPanel.tsx`,
  'utf8'
)
// The viewer UI is split across the main component and its extracted panels;
// guardrail assertions run against the combined source so panel extraction
// does not weaken them.
const VIEWER_UI = `${CREBAIN_VIEWER}\n${HEADER_BAR}\n${DETECTION_PANEL}`

describe('CI workflow', () => {
  it('uses package validation scripts for frontend and backend checks', () => {
    for (const script of ['validate', 'check:rust', 'clippy:rust', 'test:rust']) {
      expect(PACKAGE.scripts[script]).toBeTruthy()
      expect(WORKFLOW).toContain(`bun run ${script}`)
    }
  })

  it('installs the toolchains required by package scripts', () => {
    expect(WORKFLOW).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40}/)
    expect(WORKFLOW).toContain('bun-version: 1.3.14')
    expect(WORKFLOW).toMatch(/dtolnay\/rust-toolchain@[0-9a-f]{40}/)
    expect(WORKFLOW).toContain('toolchain: 1.91.1')
  })

  it('keeps frozen compatibility overlays outside Cargo update scans', () => {
    const cargoUpdates = DEPENDABOT.match(
      /- package-ecosystem: cargo\n[\s\S]*?(?=\n {2}- package-ecosystem:|$)/
    )?.[0]

    expect(cargoUpdates).toBeTruthy()
    expect(cargoUpdates).toContain('directory: /src-tauri')
    expect(cargoUpdates).toContain("- 'vendor-compat/**'")
  })

  it('pins every third-party GitHub Action to an immutable commit', () => {
    const actionReferences = [...WORKFLOWS.matchAll(/\buses:\s*([^\s@]+)@([^\s#]+)/g)]

    expect(actionReferences.length).toBeGreaterThan(0)
    for (const [, action, revision] of actionReferences) {
      expect(revision, `${action} must use a full commit SHA`).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('disables persisted credentials for every checkout step', () => {
    for (const { file, source } of WORKFLOW_SOURCES) {
      const lines = source.split('\n')
      for (const [index, line] of lines.entries()) {
        const checkout = line.match(/^(\s*)-\s+uses:\s+actions\/checkout@/)
        if (!checkout) continue

        const stepIndent = checkout[1].length
        const nextStepOffset = lines
          .slice(index + 1)
          .findIndex((candidate) => new RegExp(`^\\s{${stepIndent}}-\\s+`).test(candidate))
        const stepEnd = nextStepOffset === -1 ? lines.length : index + 1 + nextStepOffset
        const step = lines.slice(index, stepEnd).join('\n')

        expect(step, `${file}:${index + 1} must disable persisted credentials`).toContain(
          'persist-credentials: false'
        )
      }
    }
  })

  it('isolates release publication from builds and seals a strict package inventory', () => {
    const buildJob = RELEASE_WORKFLOW.match(/\n {2}build:\n[\s\S]*?\n {2}seal-evidence:/)?.[0]
    const sealJob = RELEASE_WORKFLOW.match(
      /\n {2}seal-evidence:\n[\s\S]*?\n {2}attest-packages:/
    )?.[0]
    const publishJob = RELEASE_WORKFLOW.match(/\n {2}publish-prerelease:\n[\s\S]*$/)?.[0]

    expect(buildJob).toBeTruthy()
    expect(sealJob).toBeTruthy()
    expect(publishJob).toBeTruthy()
    expect(RELEASE_WORKFLOW.match(/contents: write/g)).toHaveLength(1)
    expect(buildJob).not.toContain('contents: write')
    expect(buildJob).not.toContain('GITHUB_TOKEN')
    expect(buildJob).toContain(
      'release-package-${{ matrix.platform }}-${{ github.sha }}-${{ github.run_id }}'
    )
    expect(RELEASE_WORKFLOW).toContain("- 'v0.9.0'")
    expect(RELEASE_WORKFLOW).not.toContain("- 'v*'")
    expect(RELEASE_WORKFLOW.match(/overwrite: true/g)).toHaveLength(3)
    expect(sealJob).not.toContain('contents: write')
    expect(sealJob).not.toContain('gh release')
    expect(sealJob).toContain('crebain-${GITHUB_REF_NAME}-evidence.tar.gz')
    for (const asset of [
      'crebain_${version}_aarch64.dmg',
      'crebain_${version}_amd64.AppImage',
      'crebain_${version}_amd64.deb',
    ]) {
      expect(buildJob).toContain(asset)
      expect(sealJob).toContain(asset)
      expect(publishJob).toContain(asset)
    }
    expect(publishJob).toContain('cmp /tmp/expected-assets.txt /tmp/actual-assets.txt')
    expect(publishJob).toContain('contents: write')
    expect(publishJob).not.toContain('actions/checkout')
    expect(publishJob).not.toContain('bun install')
    expect(publishJob).toContain('sealed-release-output-${{ github.sha }}-${{ github.run_id }}')
    expect(publishJob).toContain('gh api --method DELETE')
    expect(publishJob).toContain('git/ref/tags/$GITHUB_REF_NAME')
    expect(publishJob).toContain('git/tags/$annotated_tag_sha')
    expect(publishJob?.match(/\.object\.sha == \$commit/g)).toHaveLength(2)
    expect(publishJob).toContain('test "${#assets[@]}" -eq 5')
    expect(publishJob).toContain('cmp "$local_asset"')
    expect(publishJob).toContain('gh api --method PATCH')
    expect(publishJob).toContain('-F draft=false')
    expect(publishJob).toContain('-F prerelease=true')
    expect(publishJob).toContain('-f make_latest=false')
    expect(publishJob?.match(/X-GitHub-Api-Version: 2026-03-10/g)).toHaveLength(2)
    expect(publishJob).toContain('.draft == false and .prerelease == true')
    expect(publishJob?.match(/\.immutable == true/g)).toHaveLength(3)
    expect(
      publishJob?.match(
        /\.id == \$release_id and \.tag_name == \$tag and \.draft == false and \.prerelease == true and \.immutable == true/g
      )
    ).toHaveLength(2)
    expect(publishJob).toContain('cmp /tmp/expected-assets.txt /tmp/refetched-public-assets.txt')
    expect(publishJob).toContain('trap rollback_publication EXIT')
    expect(publishJob).toContain("jq -e '.immutable == true' /tmp/public-release.json")
    expect(publishJob).toContain('immutable publication cannot be returned to draft')
    expect(publishJob).toContain('-F draft=true -F prerelease=true')
  })

  it('uses clang reported runtime path for macOS ONNX linking', () => {
    for (const workflow of [WORKFLOW, RELEASE_WORKFLOW]) {
      expect(workflow).toContain('xcrun clang --print-resource-dir')
      expect(workflow).toContain('test -e "$CLANG_RT_DIR/libclang_rt.osx.a"')
      expect(workflow).toContain('RUSTFLAGS=-Lnative=$CLANG_RT_DIR')
      expect(workflow).toContain('LIBRARY_PATH=$CLANG_RT_DIR')
    }
  })

  it('keeps full validation composed from the package scripts documented in README', () => {
    for (const script of ['validate', 'check:rust', 'test:rust', 'clippy:rust']) {
      expect(PACKAGE.scripts['validate:all']).toContain(`bun run ${script}`)
      expect(README).toContain(`bun run ${script}`)
    }
  })

  it('keeps the stabilization roadmap aligned with completed validation work', () => {
    for (const item of [
      'Local no-authority guidance-preview tests and reset/hold checks',
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

    expect(RELEASE_ACCEPTANCE).toContain('Demo, operational, and 1.0 release-candidate gate')
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
    expect(RELEASE_EVIDENCE).toContain('Hosted source gates')
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
      'Renderer ROS telemetry',
      'Native rosbridge telemetry fallback',
      'Zenoh transport',
      'Tauri commands/events',
    ]) {
      expect(SECURITY).toContain(boundary)
    }

    for (const phrase of [
      'model path',
      'scene file',
      'telemetry topic',
      'structured error payloads',
    ]) {
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

    expect(VIEWER_UI).toContain('VERTRAG OFFEN')
    expect(VIEWER_UI).toContain('NICHT KONFIG.')
    expect(VIEWER_UI).toContain('SIM POS')
    expect(VIEWER_UI).not.toContain("const networkStatus = 'VERBUNDEN'")
    expect(VIEWER_UI).not.toContain('AES-256')
    expect(VIEWER_UI).not.toContain('<span className="text-[#808080]">YOLOv8s</span>')

    expect(README).toContain('MLX is experimental, opt-in')
    expect(README).toContain('requires external model-contract validation before release claims')
    expect(README).not.toContain('zero-output scaffold')
    expect(README).not.toContain('scaffolded zero-output detections')
  })
})
