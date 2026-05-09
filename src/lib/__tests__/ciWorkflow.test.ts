import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const PACKAGE = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8')) as { scripts: Record<string, string> }
const WORKFLOW = readFileSync(`${process.cwd()}/.github/workflows/ci.yml`, 'utf8')

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
})
