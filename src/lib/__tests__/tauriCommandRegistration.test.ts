import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { TAURI_COMMANDS } from '../tauriCommands'

const BACKEND = readFileSync(`${process.cwd()}/src-tauri/src/lib.rs`, 'utf8')
const TRANSPORT_COMMANDS = readFileSync(`${process.cwd()}/src-tauri/src/transport/commands.rs`, 'utf8')
const COMMAND_SOURCES = `${BACKEND}\n${TRANSPORT_COMMANDS}`

function commandValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(commandValues)
}

function invokeHandlerCommands(source: string): string[] {
  const handler = source.match(/generate_handler!\[([\s\S]*?)\]\)/)
  if (!handler) return []
  return handler[1]
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter(Boolean)
}

describe('Tauri command registration', () => {
  it('registers every frontend command constant in the backend invoke handler', () => {
    const registered = new Set(invokeHandlerCommands(BACKEND))

    for (const command of commandValues(TAURI_COMMANDS)) {
      expect(registered.has(command)).toBe(true)
    }
  })

  it('keeps registered command symbols backed by command functions', () => {
    for (const command of invokeHandlerCommands(BACKEND)) {
      expect(COMMAND_SOURCES).toMatch(new RegExp(`(?:async\\s+)?fn\\s+${command}\\b`))
    }
  })
})
