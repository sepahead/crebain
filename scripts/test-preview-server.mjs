import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  MAX_PREVIEW_OUTPUT,
  observePreviewServer,
  previewReportsReady,
  startPreviewServer,
  waitForServer,
} from './preview-server.mjs'

const URL = 'http://127.0.0.1:4173/'
const colored =
  '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://127.0.0.1:\x1b[1m4173\x1b[22m/\x1b[39m\n'
function fixture(program, timeoutMs = 1_000) {
  return observePreviewServer(
    spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] }),
    URL,
    timeoutMs
  )
}

test('plain and exact Vite SGR banners identify only the requested complete endpoint', () => {
  for (const text of [`  ➜ Local: ${URL}\n`, colored, `Local: ${URL}\r\n`])
    assert.equal(previewReportsReady(text, URL), true)
  for (const text of [
    colored.replace('4173', '4174'),
    colored.replace('127.0.0.1', '127.0.0.2'),
    `error mentions Local: ${URL}\n`,
    `Local: ${URL}extra\n`,
    `Local: ${URL}`,
    `Local: ${URL} trailing\n`,
    `\x1b[2JLocal: ${URL}\n`,
    `\x1b[${'1;'.repeat(100)}mLocal: ${URL}\n`,
    `\x1b[1mLocal: ${URL}\n\x1b[`,
    `Local: ${URL}\n${'x'.repeat(MAX_PREVIEW_OUTPUT)}`,
  ])
    assert.equal(previewReportsReady(text, URL), false, JSON.stringify(text))
  for (const url of [
    'https://127.0.0.1:4173/',
    'http://localhost:4173/',
    'http://127.0.0.1:4173/path',
    'http://u@127.0.0.1:4173/',
  ]) {
    assert.throws(() => previewReportsReady('', url), /loopback/)
  }
})

test('split ANSI output is joined and the exact owned child is reaped', async () => {
  const cut = colored.indexOf('Local') + 3
  const child = fixture(
    `process.stdout.write(${JSON.stringify(colored.slice(0, cut))});setTimeout(()=>process.stdout.write(${JSON.stringify(colored.slice(cut))}),20);setInterval(()=>{},1000)`
  )
  try {
    await child.ready
    child.assertRunning()
    assert.equal(child.diagnostics, colored)
  } finally {
    await child.stop()
  }
  assert.throws(() => child.assertRunning(), /no longer running/)
  await child.stop()
})

test('spawn failure and exit before readiness reject without a successful fallback', async () => {
  const absent = observePreviewServer(
    spawn('/nonexistent-crebain-preview-fixture', [], { stdio: ['ignore', 'pipe', 'pipe'] }),
    URL
  )
  await assert.rejects(absent.ready, /ENOENT/)
  await absent.stop()
  const exited = fixture('process.exit(17)')
  await assert.rejects(exited.ready, /exited/)
  await exited.stop()
})

test('wrong and incomplete banners time out, preserving bounded original diagnostics', async () => {
  for (const output of [colored.replace('4173', '4174'), '\x1b[1mLocal: ']) {
    const child = fixture(
      `process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000)`,
      200
    )
    try {
      await assert.rejects(child.ready, /readiness/)
      assert.equal(child.diagnostics, output)
    } finally {
      await child.stop()
    }
  }
})

test('oversized startup output cannot discard an incomplete escape into accepted text', async () => {
  const child = fixture(
    `process.stdout.write('\\x1b['+'1'.repeat(20000)+'\\nLocal: ${URL}\\n');setInterval(()=>{},1000)`
  )
  try {
    await assert.rejects(child.ready, /output bound/)
    assert.ok(child.diagnostics.length <= MAX_PREVIEW_OUTPUT)
  } finally {
    await child.stop()
  }
})

test('an unresponsive owned child is forcibly terminated and reaped', async () => {
  const child = fixture(
    `process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(colored)});setInterval(()=>{},1000)`
  )
  await child.ready
  await child.stop()
  assert.equal(child.child.signalCode, 'SIGKILL')
})

test('HTTP readiness joins the exact endpoint, live owner, and bounded response', async () => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const endpoint = `http://127.0.0.1:${port}/`
  const program = `require('node:http').createServer((q,r)=>r.end('owned')).listen(${port},'127.0.0.1',()=>process.stdout.write('Local: ${endpoint}\\n'))`
  const child = observePreviewServer(
    spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] }),
    endpoint,
    1_000
  )
  try {
    await child.ready
    await waitForServer(endpoint, child, 1_000)
    await assert.rejects(waitForServer('http://127.0.0.1:1/', child, 1_000), /differs/)
  } finally {
    await child.stop()
  }
  const unrelated = createServer((_request, response) => response.end('unrelated'))
  unrelated.listen(port, '127.0.0.1')
  await once(unrelated, 'listening')
  try {
    assert.equal(await (await fetch(endpoint)).text(), 'unrelated')
    await assert.rejects(waitForServer(endpoint, child, 1_000), /no longer running/)
  } finally {
    await new Promise((resolve) => unrelated.close(resolve))
  }
  const hanging = createServer(() => {})
  hanging.listen(0, '127.0.0.1')
  await once(hanging, 'listening')
  try {
    await assert.rejects(
      waitForServer(`http://127.0.0.1:${hanging.address().port}/`, undefined, 150),
      /did not become ready/
    )
  } finally {
    hanging.closeAllConnections()
    await new Promise((resolve) => hanging.close(resolve))
  }
})

test('actual Vite cannot borrow an unrelated listener on its strict port', async () => {
  const unrelated = createServer((_request, response) => response.end('unrelated'))
  unrelated.listen(0, '127.0.0.1')
  await once(unrelated, 'listening')
  const endpoint = `http://127.0.0.1:${unrelated.address().port}/`
  const preview = startPreviewServer(endpoint)
  try {
    await assert.rejects(preview.ready, /exited/)
    assert.match(preview.diagnostics, /already in use/)
    assert.equal(await (await fetch(endpoint)).text(), 'unrelated')
  } finally {
    await preview.stop()
    await new Promise((resolve) => unrelated.close(resolve))
  }
})

test('post-spawn errors cannot substitute for observed process exit', async () => {
  const child = fixture(
    `process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(colored)});setInterval(()=>{},1000)`
  )
  try {
    await child.ready
    child.child.emit('error', new Error('injected post-spawn child error'))
    child.child.emit('error', new Error('second child error'))
    assert.throws(() => child.assertRunning(), /injected post-spawn/)
    await child.stop()
    assert.equal(child.child.signalCode, 'SIGKILL')
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) {
      const exited = once(child.child, 'exit')
      child.child.kill('SIGKILL')
      await exited
    }
  }
})

test('UTF-8 banner characters survive arbitrary byte chunk boundaries', async () => {
  const child = fixture(
    `const b=Buffer.from(${JSON.stringify(colored)});const cut=b.indexOf(Buffer.from('➜'))+1;process.stdout.write(b.subarray(0,cut));setTimeout(()=>process.stdout.write(b.subarray(cut)),20);setInterval(()=>{},1000)`
  )
  try {
    await child.ready
    assert.equal(child.diagnostics, colored)
  } finally {
    await child.stop()
  }
})
