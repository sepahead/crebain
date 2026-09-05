import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { classifyOwnedProcess } from './lib/owned-process-identity.mjs'

const original = {
  pid: 123,
  ppid: 100,
  pgid: 123,
  started: 'frozen-start',
  command: '/owned/browser',
  state: 'Ss',
}
assert.equal(classifyOwnedProcess(original, original), 'owned-live')
assert.equal(classifyOwnedProcess(original, null), 'missing')
for (const state of ['Z', '?Es'])
  assert.equal(
    classifyOwnedProcess(original, { ...original, state, command: '<unavailable>' }),
    'owned-exiting'
  )
assert.equal(classifyOwnedProcess(original, { ...original, command: '/unrelated/live' }), 'changed')
for (const key of ['pid', 'ppid', 'pgid', 'started'])
  assert.equal(
    classifyOwnedProcess(original, {
      ...original,
      [key]: 'changed',
      state: 'Z',
      command: '<defunct>',
    }),
    'changed'
  )

const child = spawn(
  process.execPath,
  [
    '-e',
    "process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.title='owned-process-title-control';process.stdout.write('changed\\n')});setInterval(()=>{},1000)",
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] }
)
function snapshot() {
  const fields = execFileSync(
    '/bin/ps',
    ['-p', String(child.pid), '-o', 'pid=,ppid=,pgid=,lstart=,stat=,command='],
    { encoding: 'utf8', timeout: 1000 }
  )
    .trim()
    .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/)
  assert(fields)
  return {
    pid: Number(fields[1]),
    ppid: Number(fields[2]),
    pgid: Number(fields[3]),
    started: fields[4],
    state: fields[5],
    command: fields[6],
  }
}
try {
  await once(child.stdout, 'data')
  const before = snapshot()
  child.stdin.write('change\n')
  await once(child.stdout, 'data')
  const after = snapshot()
  assert.notEqual(before.command, after.command)
  assert.equal(classifyOwnedProcess(before, after), 'changed')
  assert.doesNotThrow(() => process.kill(child.pid, 0))
} finally {
  child.kill('SIGKILL')
  await once(child, 'exit')
}
console.log(
  'Owned process identity: nine classification controls and actual changed-live-command control passed'
)
