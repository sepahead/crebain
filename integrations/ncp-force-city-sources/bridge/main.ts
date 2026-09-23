import { once } from 'node:events'
import { readExact } from './framing'
import { isAbsolute } from 'node:path'
import { decodeFrame, object, keys } from './codec'
import { actualFactory, CityBridge } from './owner'
import { reportCityFailure } from './failure'
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
let preparedGraphics: GraphicsModule.OwnedGraphicsProcess | undefined
const bridge = new CityBridge(
  actualFactory(
    nodeExecutable === undefined
      ? undefined
      : async (plan) => {
          const { OwnedGraphicsProcess } = (await import(moduleUrl.href)) as typeof GraphicsModule
          preparedGraphics = await OwnedGraphicsProcess.prepareSources(JSON.stringify(plan), {
            timeoutMs: 30000,
            nodeExecutable,
          })
          return preparedGraphics
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

async function send(body: unknown): Promise<void> {
  const response = { schema: 'crebain.city-engine-response.v1', generation, sequence, body }
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
    const frameDeadline = performance.now() + 120000
    const prefix = await readExact(process.stdin, 4, frameDeadline)
    if (!prefix) break
    const length = prefix.readUInt32BE()
    if (length === 0 || length > 65536) throw new Error('Private frame bound')
    const bytes = await readExact(process.stdin, length, frameDeadline)
    if (!bytes) throw new Error('Truncated private payload')
    const request = decodeFrame(bytes)
    if (request.generation !== generation || request.sequence !== sequence + 1)
      throw new Error('Private request lineage')
    sequence++
    const command = object(request.command)
    const body = await deadline(bridge.command(command), command.kind === 'retire' ? 45000 : 60000)
    if (parentGone) throw new Error('Parent channel closed')
    if (command.kind === 'prepare') {
      const data = object(keys(body, ['kind', 'data']).data)
      const observed = preparedGraphics?.diagnostics() ?? null
      const receipt = {
        schema: 'crebain.city-engine-runtime-receipt.v1',
        generation,
        sequence,
        run_id: command.run_id,
        source_identity: command.source_identity,
        engine_pid: process.pid,
        owner_id: data.owner_id,
        native_plan_sha256: data.native_plan_sha256,
        scene_sha256: data.scene_sha256,
        graphics: observed,
        identity_scope: 'local-process-observation-not-loaded-code-or-hardware-proof',
      }
      const line = Buffer.from(`CREBAIN_CITY_RUNTIME_V1 ${JSON.stringify(receipt)}\n`)
      if (line.length > 4096) throw new Error('City runtime observation byte bound')
      await writeRuntimeReceipt(line)
    }
    await deadline(send(body), 5000)
    retired = command.kind === 'retire'
  }
  if (!(await deadline(bridge.retire(), 45000))) {
    process.exitCode = 1
    await reportCityFailure(
      new Error('City retirement was not confirmed'),
      bridge.retirementFailures()
    )
  }
} catch (error) {
  const retirement: unknown[] = []
  await deadline(bridge.retire(), 45000).catch((cleanup) => {
    retirement.push(cleanup)
  })
  retirement.push(...bridge.retirementFailures())
  // A failed generation cannot await another caller frame to release its own stdin.
  try {
    process.stdin.destroy()
  } catch (cleanup) {
    retirement.push(cleanup)
  }
  process.exitCode = 1
  await reportCityFailure(error, retirement)
}
