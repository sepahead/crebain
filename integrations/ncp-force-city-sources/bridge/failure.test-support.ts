// Actual executable-boundary control. No native owner or graphics process is constructed.
import { CityBridge } from './owner'
import { CityEnvironmentError } from '../../../src/environment/ForceCityEnvironment'

CityBridge.prototype.command = async () => {
  throw new CityEnvironmentError(
    {
      stage: 'source',
      executedTick: 1,
      componentCleanup: 'unresolved',
      processRetirement: 'outside_component_scope',
      completeObservation: false,
      primaryFailure: 'synthetic primary operation',
      secondaryFailures: [],
      cleanupFailures: ['synthetic nested cleanup'],
    },
    null,
    new Error('synthetic primary operation'),
    [new Error('synthetic nested cleanup')],
    []
  )
}
CityBridge.prototype.retire = async () => {
  throw new Error('synthetic final cleanup')
}
await import('./main')
