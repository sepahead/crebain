/** Maximum number of waypoints admitted for one drone route. */
export const MAX_ROUTE_WAYPOINTS = 256
/** Matches the scene-state coordinate component envelope. */
export const MAX_ROUTE_COORDINATE_MAGNITUDE_M = 1_000_000
/** Greatest declared ceiling among the built-in 0.9 drone profiles. */
export const MAX_ROUTE_ALTITUDE_M = 4_500
/** Route speed is a dimensionless multiplier; 2 keeps commanded pitch bounded. */
export const MAX_ROUTE_SPEED_MULTIPLIER = 2

export interface RouteAdmissionLimits {
  maxAltitude?: number
  maxSpeedMultiplier?: number
}

function boundedLimit(candidate: number | undefined, fallback: number): number {
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? Math.min(candidate, fallback)
    : fallback
}

function resolveRouteLimits(limits?: RouteAdmissionLimits): {
  maxAltitude: number
  maxSpeedMultiplier: number
} {
  return {
    maxAltitude: boundedLimit(limits?.maxAltitude, MAX_ROUTE_ALTITUDE_M),
    maxSpeedMultiplier: boundedLimit(limits?.maxSpeedMultiplier, MAX_ROUTE_SPEED_MULTIPLIER),
  }
}

export interface RouteWaypointInput {
  x: string
  y: string
  z: string
}

export function parseWaypointInput(
  input: RouteWaypointInput,
  limits?: RouteAdmissionLimits
): { x: number; y: number; z: number } | null {
  if (input.x.trim() === '' || input.y.trim() === '' || input.z.trim() === '') return null
  const parsed = { x: Number(input.x), y: Number(input.y), z: Number(input.z) }
  const { maxAltitude } = resolveRouteLimits(limits)
  return Number.isFinite(parsed.x) &&
    Math.abs(parsed.x) <= MAX_ROUTE_COORDINATE_MAGNITUDE_M &&
    Number.isFinite(parsed.y) &&
    parsed.y >= 0 &&
    parsed.y <= maxAltitude &&
    Number.isFinite(parsed.z) &&
    Math.abs(parsed.z) <= MAX_ROUTE_COORDINATE_MAGNITUDE_M
    ? parsed
    : null
}

export interface FiniteRouteWaypoint {
  position: { x: number; y: number; z: number }
  altitude: number
  speed?: number
}

export function isAdmissibleRoutePosition(
  value: unknown,
  limits?: RouteAdmissionLimits
): value is FiniteRouteWaypoint['position'] {
  if (typeof value !== 'object' || value === null) return false
  const position = value as { x?: unknown; y?: unknown; z?: unknown }
  const { maxAltitude } = resolveRouteLimits(limits)
  return (
    typeof position.x === 'number' &&
    Number.isFinite(position.x) &&
    Math.abs(position.x) <= MAX_ROUTE_COORDINATE_MAGNITUDE_M &&
    typeof position.y === 'number' &&
    Number.isFinite(position.y) &&
    position.y >= 0 &&
    position.y <= maxAltitude &&
    typeof position.z === 'number' &&
    Number.isFinite(position.z) &&
    Math.abs(position.z) <= MAX_ROUTE_COORDINATE_MAGNITUDE_M
  )
}

export function isFiniteRouteWaypoint(
  value: unknown,
  limits?: RouteAdmissionLimits
): value is FiniteRouteWaypoint {
  if (typeof value !== 'object' || value === null) return false
  const waypoint = value as {
    position?: { x?: unknown; y?: unknown; z?: unknown }
    altitude?: unknown
    speed?: unknown
  }
  const position = waypoint.position
  const { maxAltitude, maxSpeedMultiplier } = resolveRouteLimits(limits)
  return (
    isAdmissibleRoutePosition(position, limits) &&
    typeof waypoint.altitude === 'number' &&
    Number.isFinite(waypoint.altitude) &&
    waypoint.altitude >= 0 &&
    waypoint.altitude <= maxAltitude &&
    (waypoint.speed === undefined ||
      (typeof waypoint.speed === 'number' &&
        Number.isFinite(waypoint.speed) &&
        waypoint.speed >= 0 &&
        waypoint.speed <= maxSpeedMultiplier))
  )
}

export function isAdmissibleRouteWaypoints(
  value: unknown,
  limits?: RouteAdmissionLimits
): value is FiniteRouteWaypoint[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ROUTE_WAYPOINTS &&
    value.every((waypoint) => isFiniteRouteWaypoint(waypoint, limits))
  )
}
