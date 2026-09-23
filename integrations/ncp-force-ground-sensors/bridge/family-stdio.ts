import { once } from 'node:events'
import { decodeFrame, encodeFamilyFrame, unwrapFloats } from './codec'
import { FamilyChannel } from './family-channel'
import type { Request } from './family-engine-types'

/** One absolute timer per operation; partial progress never grants another interval. */
export async function withinFamilyDeadline<T>(
  operation: () => Promise<T>,
  expires: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const remaining = expires - performance.now()
  if (!Number.isFinite(remaining) || !(remaining > 0)) throw new Error('Private family deadline')
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Private family deadline')), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Read an admitted extent without requiring a whole frame in the socket buffer. */
export async function readFamilyBytes(count: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 65536)
    throw new Error('Private family byte extent')
  const bytes = Buffer.alloc(count)
  let offset = 0
  while (offset < count) {
    // Consume available fragments. Requesting the entire remainder can stall
    // above Bun's socket read buffer while readable events repeat without progress.
    const available = Math.max(1, process.stdin.readableLength)
    const chunk = process.stdin.read(Math.min(count - offset, available)) as Buffer | null
    if (chunk) {
      chunk.copy(bytes, offset)
      offset += chunk.length
      continue
    }
    if (process.stdin.readableEnded) {
      if (offset === 0) return null
      throw new Error('Truncated family private frame')
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
  return bytes
}

/** Run the fixed family channel. A failure retains its original cause through cleanup. */
export async function serveFamily(
  channel: FamilyChannel,
  generation: string,
  prepared: (request: Request, body: unknown) => Promise<void> = async () => {}
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation))
    throw new Error('Private family generation')
  let sequence = 0
  let expires = performance.now() + 60000
  let parentGone = false
  let cleanupWork: Promise<boolean> | undefined
  const retire = () =>
    (cleanupWork ??= withinFamilyDeadline(() => channel.retire(), performance.now() + 45000))
  const ended = () => {
    parentGone = true
    void retire().catch(() => {
      process.exitCode = 1
    })
  }
  process.stdin.on('end', ended)
  try {
    while (!channel.complete && !parentGone) {
      const prefix = await withinFamilyDeadline(() => readFamilyBytes(4), expires)
      if (!prefix) break
      const length = prefix.readUInt32BE()
      if (length === 0 || length > 65536) throw new Error('Private family frame bound')
      const payload = await withinFamilyDeadline(() => readFamilyBytes(length), expires)
      if (!payload) throw new Error('Truncated private family payload')
      const request = unwrapFloats(decodeFrame(payload, 'familyBridge')) as Request
      if (request.generation !== generation || request.sequence !== sequence + 1)
        throw new Error('Private family request identity')
      sequence++
      const command = request.command
      if (command.kind === 'construct') {
        if (sequence !== 1 || command.plan.family_id !== generation)
          throw new Error('Private family construction identity')
        // Construction starts the family lifetime once; subsequent traffic cannot reset it.
        expires = performance.now() + command.plan.limits.total_wall_seconds * 1000
      }
      const cleanupOperation = command.kind === 'retire'
      const operationExpires = cleanupOperation
        ? performance.now() + 45000
        : Math.min(
            expires,
            performance.now() + (command.kind.startsWith('finish_') ? 45000 : 60000)
          )
      const body = await withinFamilyDeadline(() => channel.command(command), operationExpires)
      if (parentGone) throw new Error('Family parent channel closed')
      if (command.kind === 'prepare' || command.kind === 'restore')
        await withinFamilyDeadline(() => prepared(request, body), operationExpires)
      const bytes = encodeFamilyFrame({
        schema: 'crebain.family-engine-response.v1',
        generation,
        sequence,
        body,
      })
      const header = Buffer.alloc(4)
      header.writeUInt32BE(bytes.length)
      await withinFamilyDeadline(async () => {
        if (!process.stdout.write(header)) await once(process.stdout, 'drain')
        if (!process.stdout.write(bytes)) await once(process.stdout, 'drain')
      }, operationExpires)
    }
    if (!(await retire())) throw new Error('Family native retirement unresolved')
  } catch (primary) {
    try {
      if (!(await retire()))
        throw new Error('Family cleanup remains unresolved', { cause: primary })
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], 'Family operation and cleanup failed', {
        cause: cleanup,
      })
    }
    throw primary
  } finally {
    process.stdin.off('end', ended)
    process.stdin.destroy()
  }
}
