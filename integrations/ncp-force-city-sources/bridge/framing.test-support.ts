import { createHash } from 'node:crypto'
import { readExact } from './framing'

// A directly owned child exercises the production stdin reader without any engine.
try {
  const deadline = performance.now() + 5000
  const prefix = await readExact(process.stdin, 4, deadline)
  if (!prefix) throw new Error('Missing frame')
  const payload = await readExact(process.stdin, prefix.readUInt32BE(), deadline)
  if (!payload) throw new Error('Missing payload')
  const result = Buffer.from(
    JSON.stringify({
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    })
  )
  const length = Buffer.alloc(4)
  length.writeUInt32BE(result.length)
  process.stdout.write(length)
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(result, (error) => (error ? reject(error) : resolve()))
  )
  process.stdin.destroy()
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'unknown')
  process.stdin.destroy()
  process.exitCode = 1
}
