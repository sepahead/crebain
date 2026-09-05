import { fork, execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import { classifyOwnedProcess } from './owned-process-identity.mjs'

const WORKER = fileURLToPath(new URL('./owned-graphics-worker.mjs', import.meta.url))
const MAX_INPUT_BYTES = 1024 * 1024
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,command='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 8 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/)
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            started: match[4],
            state: match[5],
            command: match[6],
          }
        : null
    })
    .filter(Boolean)
}
function primitiveJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INPUT_BYTES)
    throw new Error('Graphics input must be bounded primitive JSON text')
  JSON.parse(text)
  return text
}

/** Private process parent. Setup, capture, and cleanup have independent parent deadlines. */
export class OwnedGraphicsProcess {
  #worker
  #pending
  #sequence = 0
  #phase = 'preparing'
  #diagnostics
  #browserIdentity
  #timeoutMs
  #logs = ''
  #cleanup = null

  static async prepare(planJson, { timeoutMs = 15000, nodeExecutable } = {}) {
    primitiveJson(planJson)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Graphics watchdog must be between 100 and 60000 milliseconds')
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      throw new Error('Graphics process lifetime requires POSIX process groups')
    // Executable selection is trusted launcher configuration, never a scene or wire field.
    // Bun's pinned Playwright connection stalled in the retained runtime comparison.
    const executable = nodeExecutable ?? (process.versions.bun ? null : process.execPath)
    if (typeof executable !== 'string' || !isAbsolute(executable))
      throw new Error('Graphics preparation requires an explicit absolute Node executable')
    const owner = new OwnedGraphicsProcess()
    owner.#timeoutMs = timeoutMs
    owner.#worker = fork(WORKER, [], {
      execPath: executable,
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    })
    owner.#worker.stderr.on('data', (bytes) => {
      if (owner.#logs.length < 8192)
        owner.#logs += String(bytes).slice(0, 8192 - owner.#logs.length)
    })
    owner.#worker.on('message', (message) => owner.#receive(message))
    owner.#worker.on('error', (error) => owner.#pending?.reject(error))
    owner.#worker.on('exit', (code, signal) =>
      owner.#pending?.reject(
        new Error(`Private graphics worker exited (${code}, ${signal}): ${owner.#logs}`)
      )
    )
    try {
      const result = await owner.#request('prepare', planJson)
      if (owner.#phase !== 'preparing')
        throw new Error('Retired graphics preparation cannot publish')
      if (!owner.#browserIdentity || result.pid !== owner.#browserIdentity.pid)
        throw new Error('Graphics preparation lacks an independently joined process identity')
      owner.#diagnostics = { ...result, workerPid: owner.#worker.pid }
      owner.#phase = 'active'
      return owner
    } catch (error) {
      await owner.retire()
      throw error
    }
  }

  #receive(message) {
    if (message?.kind === 'browser') {
      try {
        const row = processRows().find((item) => item.pid === message.pid)
        if (
          !row ||
          row.ppid !== this.#worker.pid ||
          row.pgid !== row.pid ||
          !row.command.startsWith(`${chromium.executablePath()} `) ||
          this.#browserIdentity
        )
          throw new Error('Unowned browser PID announcement rejected')
        this.#browserIdentity = row
      } catch (error) {
        this.#pending?.reject(error)
      }
      return
    }
    if (!this.#pending || message?.sequence !== this.#pending.sequence) return
    if (message.kind === 'result') this.#pending.resolve(message.result)
    else if (message.kind === 'error') this.#pending.reject(new Error(message.error))
    else this.#pending.reject(new Error('Unknown private graphics worker result'))
  }

  async #request(operation, body) {
    if (this.#pending) throw new Error('Graphics process request is already pending')
    const sequence = ++this.#sequence
    let timer
    try {
      return await new Promise((resolve, reject) => {
        this.#pending = { sequence, resolve, reject }
        timer = setTimeout(
          () => {
            this.#phase = 'retired'
            void this.#terminate().then(
              (cleanup) =>
                reject(new Error(`Graphics parent watchdog expired; cleanup ${cleanup.status}`)),
              (cause) => reject(new Error('Graphics parent watchdog cleanup unresolved', { cause }))
            )
          },
          operation === 'retire' ? 5000 : this.#timeoutMs
        )
        this.#worker.send({ sequence, operation, body, timeoutMs: this.#timeoutMs }, (error) => {
          if (error) reject(error)
        })
      })
    } finally {
      clearTimeout(timer)
      this.#pending = null
    }
  }

  diagnostics() {
    return structuredClone(this.#diagnostics)
  }

  async capture(inputJson) {
    if (this.#phase !== 'active') throw new Error(`Graphics process is ${this.#phase}`)
    const input = primitiveJson(inputJson)
    this.#phase = 'busy'
    try {
      const result = await this.#request('capture', input)
      if (this.#phase !== 'busy') throw new Error('Retired graphics capture cannot publish')
      this.#phase = 'active'
      return result
    } catch (error) {
      await this.retire()
      throw error
    }
  }

  async captureJson(inputJson) {
    return JSON.stringify(await this.capture(inputJson))
  }

  async #terminate() {
    if (this.#cleanup) return this.#cleanup
    this.#cleanup = (async () => {
      let signalError = null
      let observedIdentity = null
      const original = this.#browserIdentity
      if (original) {
        try {
          const current = processRows().find((row) => row.pid === original.pid)
          observedIdentity = current ?? null
          const classification = classifyOwnedProcess(original, current)
          if (classification === 'owned-live') process.kill(-original.pgid, 'SIGKILL')
          else if (classification === 'changed')
            signalError = 'Browser identity changed; group signal withheld'
          // Same-owned exiting/zombie records require observation of disappearance below.
          // Their changed ps command text neither authorizes a signal nor proves cleanup.
        } catch (error) {
          if (error.code !== 'ESRCH') signalError = String(error)
        }
      }
      this.#worker.kill('SIGKILL')
      let remaining = []
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(50)
        try {
          remaining = processRows().filter(
            (row) => row.pid === this.#worker.pid || (original && row.pgid === original.pgid)
          )
          if (remaining.length === 0) break
        } catch (error) {
          signalError = String(error)
          break
        }
      }
      // A missing announcement cannot prove no browser was launched in the announcement race.
      return {
        status: !original || remaining.length || signalError ? 'unresolved' : 'confirmed',
        remaining,
        signalError,
        originalIdentity: original ?? null,
        observedIdentity,
      }
    })()
    return this.#cleanup
  }

  async retire() {
    const before = this.#phase
    this.#phase = 'retired'
    if (!this.#pending && before === 'active' && this.#worker.connected) {
      try {
        await this.#request('retire', null)
      } catch {
        /* Hard cleanup below remains authoritative. */
      }
    }
    const cleanup = await this.#terminate()
    if (cleanup.status !== 'confirmed')
      throw new Error(`Graphics process cleanup unresolved: ${JSON.stringify(cleanup)}`)
  }
}
