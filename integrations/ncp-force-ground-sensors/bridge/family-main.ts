import { isAbsolute } from 'node:path'
import { object, validateFrozen } from './codec'
import { actualFamilyFactory } from './family'
import { FamilyChannel } from './family-channel'
import { serveFamily } from './family-stdio'
import { reportFamilyFailure } from './family-failure'
import { graphicsInputDigest } from '../../../src/environment/GraphicsContract'
import type { PreparedGraphics } from './runtime-receipt'
import type { NativeRestored } from './family-engine-types'
import type * as GraphicsModule from './owned-graphics.mjs'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--node' || !isAbsolute(args[1]) || args[2] !== '--generation')
  throw new Error('Trusted family bridge arguments required')
const [, nodeExecutable, , generation] = args
const moduleUrl = new URL('../../../scripts/lib/owned-graphics-process.mjs', import.meta.url)
let retainedGraphics: PreparedGraphics | undefined
let graphicsCount = 0
let stderrFailed = false
process.stderr.on('error', () => {
  stderrFailed = true
})
const channel = new FamilyChannel(
  actualFamilyFactory(async (json) => {
    if (retainedGraphics || graphicsCount >= 16)
      throw new Error('Frozen family graphics roster exceeded')
    const { OwnedGraphicsProcess } = (await import(moduleUrl.href)) as typeof GraphicsModule
    const plan = object(JSON.parse(json))
    const planSha256 = await graphicsInputDigest(plan)
    const graphics = await OwnedGraphicsProcess.prepare(json, { timeoutMs: 30000, nodeExecutable })
    graphicsCount++
    retainedGraphics = {
      sourceIdentity: String(plan.sourceIdentity),
      planSha256,
      diagnostics: () => graphics.diagnostics(),
    }
    return graphics
  })
)

try {
  await serveFamily(channel, generation, async (request, body) => {
    const plan = channel.plan
    const graphics = retainedGraphics
    if (!plan || !graphics || stderrFailed)
      throw new Error('Family runtime observation unavailable')
    const result = object(body)
    const restored =
      request.command.kind === 'restore' ? (object(result.result) as NativeRestored) : null
    const slot = restored
      ? plan.branches.find((branch) => branch.case_id === restored.ancestry.case_id)?.slot
      : 0
    if (slot === undefined) throw new Error('Family runtime endpoint selection')
    const diagnostics = object(graphics.diagnostics())
    validateFrozen('Diagnostics', diagnostics, 'runtime')
    const reported = object(diagnostics.graphics)
    if (
      diagnostics.planSha256 !== graphics.planSha256 ||
      diagnostics.pid === diagnostics.workerPid ||
      [diagnostics.browserVersion, reported.version, reported.renderer, reported.vendor].includes(
        'unavailable'
      ) ||
      (restored && restored.ancestry.graphics_generation !== diagnostics.generation)
    )
      throw new Error('Family runtime graphics join')
    const receipt = {
      schema: 'crebain.family-graphics-runtime.v1',
      family_id: plan.family_id,
      family_plan_digest: channel.planDigest,
      slot,
      binding: slot === 0 ? plan.canonical_binding : plan.branches[slot - 1].binding,
      source_identity: graphics.sourceIdentity,
      native_owner_id: restored?.ancestry.native_owner_id ?? result.engine_owner_id,
      graphics: {
        generation: diagnostics.generation,
        plan_sha256: diagnostics.planSha256,
        browser_pid: diagnostics.pid,
        worker_pid: diagnostics.workerPid,
        browser_version: diagnostics.browserVersion,
        webgl_version: reported.version,
        renderer: reported.renderer,
        vendor: reported.vendor,
        distribution_scope: diagnostics.distributionScope,
      },
      identity_scope: 'browser-reported-strings-not-loaded-code-or-hardware-proof',
    }
    validateFrozen('FamilyReceipt', receipt, 'familyRuntime')
    const line = Buffer.from(`CREBAIN_FAMILY_RUNTIME_V1 ${JSON.stringify(receipt)}\n`)
    if (line.length > 4096) throw new Error('Family runtime receipt bound')
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(line, (error) => (error ? reject(error) : resolve()))
    })
    if (stderrFailed) throw new Error('Family runtime receipt transmission')
    retainedGraphics = undefined
  })
} catch (primary) {
  process.exitCode = 1
  await reportFamilyFailure(primary)
}
