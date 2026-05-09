import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { TAURI_COMMANDS } from '../tauriCommands'

function commandValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(commandValues)
}

describe('Tauri command registration', () => {
  it('registers every frontend command constant in the backend invoke handler', () => {
    const backend = readFileSync(`${process.cwd()}/src-tauri/src/lib.rs`, 'utf8')

    for (const command of commandValues(TAURI_COMMANDS)) {
      expect(backend).toContain(command)
    }
  })
})
