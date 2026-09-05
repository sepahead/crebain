import { OwnedGraphicsRuntime } from './owned-graphics-runtime.mjs'

if (process.versions.bun || !process.versions.node)
  throw new Error('The private graphics worker requires Node.js')

let owner
let busy = false
let retired = false
let pending
const send = (message) => {
  if (process.connected) process.send(message)
}
async function retire() {
  retired = true
  if (owner) await owner.retire()
}
// Parent death closes the private IPC channel. This handler requires a schedulable worker.
process.on('disconnect', () => {
  void retire().finally(() => {
    if (pending) void pending.finally(() => process.exit(0))
    else process.exit(0)
  })
})
process.on('message', (message) => {
  if (
    !message ||
    typeof message !== 'object' ||
    !Number.isSafeInteger(message.sequence) ||
    !['prepare', 'capture', 'retire'].includes(message.operation) ||
    busy ||
    retired
  ) {
    send({ kind: 'error', sequence: message?.sequence, error: 'Invalid graphics worker request' })
    return
  }
  busy = true
  pending = (async () => {
    try {
      let result
      if (message.operation === 'prepare') {
        if (owner) throw new Error('Graphics worker is already prepared')
        owner = await OwnedGraphicsRuntime.prepare(message.body, {
          timeoutMs: message.timeoutMs,
          onBrowserProcess: (pid) => send({ kind: 'browser', pid }),
        })
        if (retired) {
          await owner.retire()
          throw new Error('Preparation completed after parent retirement')
        }
        result = {
          ...owner.diagnostics(),
          workerRuntime: {
            name: 'node',
            version: process.versions.node,
            executable: process.execPath,
          },
        }
      } else if (message.operation === 'capture') {
        if (!owner) throw new Error('Graphics worker is not prepared')
        result = await owner.capture(message.body)
      } else {
        await retire()
        result = { retired: true }
      }
      if (retired && message.operation !== 'retire')
        throw new Error('Retired worker cannot publish')
      send({ kind: 'result', sequence: message.sequence, result })
    } catch (error) {
      await retire().catch(() => {})
      send({ kind: 'error', sequence: message.sequence, error: String(error).slice(0, 2048) })
    } finally {
      busy = false
    }
  })()
})
