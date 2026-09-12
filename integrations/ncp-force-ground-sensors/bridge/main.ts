import { once } from 'node:events'
import { isAbsolute } from 'node:path'
import { decodeFrame, object, validateFrozen } from './codec'
import { actualFactory, SensorBridge } from './owner'
import { publishPreparedRuntime, type PreparedGraphics } from './runtime-receipt'
import { graphicsInputDigest } from '../../../src/environment/GraphicsContract'
import type * as GraphicsModule from './owned-graphics.mjs'

const args = process.argv.slice(2)
const withNode =
  args.length === 4 && args[0] === '--node' && isAbsolute(args[1]) && args[2] === '--generation'
const withoutNode = args.length === 2 && args[0] === '--generation'
const generation = args.at(-1)
if (
  (!withNode && !withoutNode) ||
  typeof generation !== 'string' ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)
)
  throw new Error('Trusted bridge arguments')
const nodeExecutable = withNode ? args[1] : undefined
// This fixed project module is selected by source, never by the NCP peer.
const moduleUrl = new URL('../../../scripts/lib/owned-graphics-process.mjs', import.meta.url)
let preparedGraphics: PreparedGraphics | undefined
const bridge = new SensorBridge(
  actualFactory(
    nodeExecutable === undefined
      ? undefined
      : async (json) => {
          const { OwnedGraphicsProcess } = (await import(moduleUrl.href)) as typeof GraphicsModule
          const plan = object(JSON.parse(json))
          const planSha256 = await graphicsInputDigest(plan)
          const graphics = await OwnedGraphicsProcess.prepare(json, {
            timeoutMs: 30000,
            nodeExecutable,
          })
          preparedGraphics = {
            sourceIdentity: String(plan.sourceIdentity),
            planSha256,
            diagnostics: () => graphics.diagnostics(),
          }
          return graphics
        }
  )
)
let sequence = 0
let parentGone = false
let retired = false
let stderrFailed = false
process.stderr.on('error', () => {
  stderrFailed = true
})
const deadline = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Private operation deadline')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
process.stdin.on('end', () => {
  parentGone = true
  void deadline(bridge.retire(), 45000).then(
    (confirmed) => {
      if (!confirmed) process.exitCode = 1
    },
    () => {
      process.exitCode = 1
    }
  )
})

async function readExact(count: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(count)
  let offset = 0
  while (offset < count) {
    const chunk = process.stdin.read(count - offset) as Buffer | null
    if (chunk) {
      chunk.copy(buffer, offset)
      offset += chunk.length
    } else {
      if (process.stdin.readableEnded) {
        if (offset === 0) return null
        throw new Error('Truncated private frame')
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          process.stdin.off('readable', ready)
          process.stdin.off('end', ready)
          process.stdin.off('error', failed)
        }
        const ready = () => {
          cleanup()
          resolve()
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        process.stdin.once('readable', ready)
        process.stdin.once('end', ready)
        process.stdin.once('error', failed)
      })
    }
  }
  return buffer
}
async function send(body: unknown): Promise<void> {
  const response = { schema: 'crebain.sensor-engine-response.v1', generation, sequence, body }
  validateFrozen('Response', response)
  const bytes = Buffer.from(JSON.stringify(response))
  if (bytes.length > 65536) throw new Error('Response frame bound')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(bytes.length)
  if (!process.stdout.write(prefix)) await once(process.stdout, 'drain')
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain')
}
async function writeRuntimeReceipt(line: Buffer): Promise<void> {
  if (stderrFailed) throw new Error('Runtime receipt stderr failed')
  await deadline(
    new Promise<void>((resolve, reject) => {
      process.stderr.write(line, (error) => (error ? reject(error) : resolve()))
    }),
    5000
  )
  if (stderrFailed) throw new Error('Runtime receipt stderr failed')
}
try {
  while (!parentGone && !retired) {
    const prefix = await readExact(4)
    if (!prefix) break
    const length = prefix.readUInt32BE()
    if (length === 0 || length > 65536) throw new Error('Private frame bound')
    const bytes = await readExact(length)
    if (!bytes) throw new Error('Truncated private payload')
    const request = decodeFrame(bytes)
    if (request.generation !== generation || request.sequence !== sequence + 1)
      throw new Error('Private request lineage')
    sequence++
    const command = object(request.command)
    const body = await deadline(bridge.command(command), command.kind === 'retire' ? 45000 : 60000)
    if (parentGone) throw new Error('Parent channel closed')
    if (command.kind === 'prepare')
      await publishPreparedRuntime(
        request,
        body,
        preparedGraphics,
        writeRuntimeReceipt,
        async (value) => {
          if (parentGone) throw new Error('Parent channel closed before prepared publication')
          await send(value)
        }
      )
    else await send(body)
    retired = command.kind === 'retire'
  }
  if (!(await deadline(bridge.retire(), 45000))) process.exitCode = 1
} catch (error) {
  const cleanup = await deadline(bridge.retire(), 45000).catch(() => false)
  process.stderr.write(
    `CREBAIN private sensor owner failed: ${error instanceof Error ? error.message : 'unknown'}; cleanup=${cleanup}\n`
  )
  if (!parentGone && sequence > 0)
    await send({ kind: 'failed', reason: 'engine', cleanup_confirmed: cleanup }).catch(
      () => undefined
    )
  process.exitCode = 1
}
