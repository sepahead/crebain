import type { Readable } from 'node:stream'

/** Drain available bytes; requesting a whole large frame can stall Bun's stdin adapter. */
export async function readExact(
  input: Readable,
  count: number,
  deadline: number
): Promise<Buffer | null> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 65536 || !Number.isFinite(deadline))
    throw new Error('City frame extent')
  const buffer = Buffer.alloc(count)
  let offset = 0
  let ended = input.readableEnded || input.destroyed
  const end = () => {
    ended = true
  }
  input.on('end', end)
  input.on('close', end)
  try {
    while (offset < count) {
      if (performance.now() >= deadline) throw new Error('City frame deadline')
      // Read only buffered bytes, or one byte to request progress. In particular,
      // the final short fragment must not wait for EOF or another application frame.
      const available = Math.max(1, input.readableLength)
      const chunk = input.read(Math.min(count - offset, available)) as Buffer | null
      if (chunk) {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > count - offset)
          throw new Error('City byte stream changed')
        chunk.copy(buffer, offset)
        offset += chunk.length
      } else {
        if (ended || input.readableEnded || input.destroyed) {
          if (offset === 0) return null
          throw new Error('Truncated city frame')
        }
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            input.off('readable', ready)
            input.off('end', ready)
            input.off('close', ready)
            input.off('error', failed)
            if (timer) clearTimeout(timer)
          }
          const ready = () => {
            cleanup()
            resolve()
          }
          const failed = (error: Error) => {
            cleanup()
            reject(error)
          }
          input.once('readable', ready)
          input.once('end', ready)
          input.once('close', ready)
          input.once('error', failed)
          const timer = setTimeout(
            () => failed(new Error('City frame deadline')),
            Math.max(1, deadline - performance.now())
          )
        })
      }
    }
    return buffer
  } finally {
    input.off('end', end)
    input.off('close', end)
  }
}
