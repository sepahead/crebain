// Actual socket byte-framing controls only. No native owner or family is constructed.
import { sha256 } from './codec'
import { readFamilyBytes, withinFamilyDeadline } from './family-stdio'

try {
  const expires = performance.now() + 1000
  const header = await withinFamilyDeadline(() => readFamilyBytes(4), expires)
  if (!header) throw new Error('Header EOF')
  const payload = await withinFamilyDeadline(() => readFamilyBytes(header.readUInt32BE()), expires)
  if (!payload) throw new Error('Payload EOF')
  process.stdout.write(JSON.stringify({ bytes: payload.length, sha256: sha256(payload) }) + '\n')
} catch (error) {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 1
} finally {
  process.stdin.destroy()
}
