import {
  familyFailureLine,
  reportFamilyFailure,
} from '../../ncp-force-ground-sensors/bridge/family-failure'

/** Adapt native sidecars into bounded advisory edges without invoking their getters. */
function failureGraph(primary: unknown, retirement: readonly unknown[]): unknown {
  const members: unknown[] = [primary]
  if (primary !== null && (typeof primary === 'object' || typeof primary === 'function')) {
    for (const name of ['cleanupErrors', 'secondaryErrors']) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(primary, name)
        if (descriptor) {
          const sidecar = { message: `Native ${name}` }
          // The shared formatter inspects this descriptor without calling accessors.
          Object.defineProperty(sidecar, 'errors', descriptor)
          members.push(sidecar)
        }
      } catch {
        members.push({ message: `Native ${name} inspection unavailable`, errors: null })
      }
    }
  }
  // Production supplies at most the native retirement failure and its deadline failure.
  // Retain a wider caller roster as one bounded formatter edge instead of copying it.
  if (retirement.length)
    members.push({ message: 'City process retirement failures', errors: retirement })
  return new AggregateError(members, 'City operation and retirement diagnostics')
}

function cityLabel(line: Buffer): Buffer {
  return Buffer.from(
    line
      .toString('ascii')
      .replace('CREBAIN_FAMILY_FAILURE_V1 ', 'CREBAIN_CITY_FAILURE_V1 ')
      .replace('"schema":"crebain.family-failure.v1"', '"schema":"crebain.city-failure.v1"')
  )
}

/** Reuse the qualified eight-node/eight-edge, 4,096-byte formatter without changing authority. */
export function cityFailureLine(primary: unknown, retirement: readonly unknown[] = []): Buffer {
  return cityLabel(familyFailureLine(failureGraph(primary, retirement)))
}

/** Diagnostic delivery has the shared one-second bound and never replaces the failure. */
export function reportCityFailure(
  primary: unknown,
  retirement: readonly unknown[] = [],
  write: (line: Buffer, done: (error?: Error | null) => void) => unknown = (line, done) =>
    process.stderr.write(line, done)
): Promise<boolean> {
  return reportFamilyFailure(failureGraph(primary, retirement), (line, done) =>
    write(cityLabel(line), done)
  )
}
