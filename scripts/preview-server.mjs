import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const MAX_PREVIEW_OUTPUT = 8_192
const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

function expectedEndpoint(baseUrl) {
  const url = new URL(baseUrl)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('owned preview requires an explicit loopback HTTP port and root path')
  }
  return url
}

export function previewReportsReady(output, baseUrl) {
  const expected = expectedEndpoint(baseUrl).href
  if (output.length > MAX_PREVIEW_OUTPUT) return false
  // Vite uses SGR color/style sequences. Other control sequences are not readiness text.
  const plain = output.replace(/\x1b\[[0-9;]{0,64}m/gu, '')
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(plain)) return false
  return [...plain.matchAll(/(?:^|\n)[\t ]*(?:➜[\t ]*)?Local:[\t ]+([^\s]+)[\t ]*\r?\n/gu)].some(
    (match) => match[1] === expected
  )
}

// The caller supplies the child it just launched; log text is not process attestation.
export function observePreviewServer(child, baseUrl, timeoutMs = READY_TIMEOUT_MS) {
  expectedEndpoint(baseUrl)
  let diagnostics = ''
  let startupLength = 0
  let launchError
  let settleReady
  let settled = false
  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
  })
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => settleReady(new Error('launched preview did not report readiness')),
      timeoutMs
    )
    settleReady = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
  })
  const retain = (chunk) => {
    const text = String(chunk)
    diagnostics = `${diagnostics}${text}`.slice(-MAX_PREVIEW_OUTPUT)
    if (!settled) startupLength += text.length
    if (startupLength > MAX_PREVIEW_OUTPUT) {
      settleReady(new Error('preview startup exceeded its output bound'))
      return
    }
    if (previewReportsReady(diagnostics, baseUrl)) settleReady()
  }
  child.stdout.setEncoding('utf8').on('data', retain)
  child.stderr.setEncoding('utf8').on('data', retain)
  child.on('error', (error) => {
    launchError ??= error
    settleReady(error)
  })
  child.once('exit', (code, signal) => {
    settleReady(new Error(`preview exited (${signal ?? code}) before readiness`))
  })
  function assertEndpoint(url) {
    if (expectedEndpoint(url).href !== expectedEndpoint(baseUrl).href) {
      throw new Error('HTTP probe differs from the owned preview endpoint')
    }
    assertRunning()
  }
  function assertRunning() {
    if (launchError) throw launchError
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('owned preview process is no longer running')
    }
  }
  async function waitForExit(timeoutMs) {
    let timeout
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  async function stop() {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    if (await waitForExit(STOP_TIMEOUT_MS)) return
    child.kill('SIGKILL')
    if (!(await waitForExit(STOP_TIMEOUT_MS))) {
      throw new Error('owned preview termination was not confirmed')
    }
  }
  return {
    child,
    ready,
    assertRunning,
    assertEndpoint,
    stop,
    get diagnostics() {
      return diagnostics
    },
  }
}

export function startPreviewServer(baseUrl) {
  const url = expectedEndpoint(baseUrl)
  // Same local Bun/Vite CLI and configuration as `bun run preview`, without wrapper processes.
  const child = spawn(
    'bun',
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      url.hostname,
      '--port',
      url.port,
      '--strictPort',
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  return observePreviewServer(child, baseUrl)
}

export async function waitForServer(baseUrl, preview, timeoutMs = READY_TIMEOUT_MS) {
  preview?.assertEndpoint(baseUrl)
  const deadline = performance.now() + timeoutMs
  let lastError
  while (performance.now() < deadline) {
    preview?.assertRunning()
    try {
      const response = await fetch(baseUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(Math.min(1_000, deadline - performance.now())))
        ),
      })
      await response.body?.cancel()
      preview?.assertRunning()
      if (response.ok) return
      lastError = new Error(`preview returned HTTP ${response.status}`)
    } catch (error) {
      preview?.assertRunning()
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`preview did not become ready: ${String(lastError)}`)
}
