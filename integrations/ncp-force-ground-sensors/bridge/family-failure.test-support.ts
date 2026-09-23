// Actual executable-boundary control. This entrypoint performs no native construction.
import { FamilyChannel } from './family-channel'

FamilyChannel.prototype.command = async () => {
  throw new Error('synthetic primary operation failure')
}
FamilyChannel.prototype.retire = async () => {
  throw new Error('synthetic separate cleanup failure')
}
await import('./family-main')
