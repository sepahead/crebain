// Actual process/transport controls only. This entrypoint never executes native dynamics or graphics.
import { FamilyChannel } from './family-channel'
import { serveFamily } from './family-stdio'
import { SyntheticCheckpointOwner } from './family-fixtures.test-support'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--node' || args[2] !== '--generation')
  throw new Error('Synthetic family fixture arguments')
const channel = new FamilyChannel(async (plan) => new SyntheticCheckpointOwner(plan))
try {
  await serveFamily(channel, args[3])
} catch (error) {
  process.stderr.write(`Synthetic family fixture failed: ${String(error)}\n`)
  process.exitCode = 1
}
