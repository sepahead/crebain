import { keys, object, validateFrozen } from './codec'

export const RUNTIME_RECEIPT_PREFIX = 'CREBAIN_SENSOR_RUNTIME_V1 '
export const MAX_RUNTIME_RECEIPT_BYTES = 4096

export interface PreparedGraphics {
  sourceIdentity: string
  planSha256: string
  diagnostics(): unknown
}

/** Publish observed driver strings before prepared; this grants no sensor or process authority. */
export async function publishPreparedRuntime(
  request: Record<string, unknown>,
  prepared: unknown,
  graphics: PreparedGraphics | undefined,
  write: (line: Buffer) => Promise<void>,
  publish: (body: unknown) => Promise<void>
): Promise<void> {
  validateFrozen('Request', request)
  const command = object(request.command)
  if (request.sequence !== 1 || command.kind !== 'prepare' || !graphics)
    throw new Error('Runtime receipt requires completed preparation')
  validateFrozen('Response', {
    schema: 'crebain.sensor-engine-response.v1',
    generation: request.generation,
    sequence: request.sequence,
    body: prepared,
  })
  const body = keys(prepared, ['kind', 'engine_owner_id', 'scene_sha256'])
  if (body.kind !== 'prepared') throw new Error('Runtime receipt preparation kind')
  const diagnostics = object(graphics.diagnostics())
  validateFrozen('Diagnostics', diagnostics, 'runtime')
  const reported = object(diagnostics.graphics)
  if (
    diagnostics.planSha256 !== graphics.planSha256 ||
    command.source_identity !== graphics.sourceIdentity ||
    diagnostics.pid === diagnostics.workerPid ||
    [diagnostics.browserVersion, reported.version, reported.renderer, reported.vendor].includes(
      'unavailable'
    )
  )
    throw new Error('Runtime receipt source or graphics join')
  const receipt = {
    schema: 'crebain.sensor-engine-runtime-receipt.v1',
    generation: request.generation,
    sequence: request.sequence,
    run_id: command.run_id,
    source_identity: command.source_identity,
    engine_owner_id: body.engine_owner_id,
    scene_sha256: body.scene_sha256,
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
  validateFrozen('Receipt', receipt, 'runtime')
  const line = Buffer.from(`${RUNTIME_RECEIPT_PREFIX}${JSON.stringify(receipt)}\n`)
  if (line.length > MAX_RUNTIME_RECEIPT_BYTES) throw new Error('Runtime receipt byte bound')
  await write(line)
  await publish(prepared)
}
