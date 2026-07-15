import {
  MAX_GLB_ANIMATION_CHANNELS,
  MAX_GLB_ANIMATION_KEYFRAMES,
  MAX_GLB_ANIMATION_TRACKS,
  MAX_GLB_ANIMATION_WORK_COMPONENTS,
  MAX_GLB_DECODED_ACCESSOR_BYTES,
  MAX_GLB_GRAPH_VISITS,
  MAX_GLB_INSTANTIATED_DRAW_ELEMENTS,
  MAX_GLB_INSTANTIATED_MORPH_WORK,
  MAX_GLB_METADATA_CLONE_BYTES,
  MAX_GLB_MESH_PRIMITIVES,
  MAX_GLB_MORPH_TEXTURE_BYTES,
  MAX_GLB_NODES,
  MAX_GLB_PRIMITIVE_INSTANCES,
  MAX_GLB_TEXTURE_PIXELS,
  type GlbValidationSummary,
} from './glbValidation'

export const MAX_GLB_SOURCE_BYTES = 128 * 1024 * 1024
export const MAX_GLB_SCENE_SOURCE_BYTES = 512 * 1024 * 1024

export const GLB_SCENE_RESOURCE_FIELDS = [
  'decodedAccessorBytes',
  'decodedTexturePixels',
  'residentTexturePixels',
  'nodes',
  'meshPrimitives',
  'primitiveInstances',
  'instantiatedDrawElements',
  'instantiatedMorphWork',
  'morphTextureBytes',
  'graphVisits',
  'animationChannels',
  'animationKeyframes',
  'animationTracks',
  'animationWorkComponents',
  'metadataCloneBytes',
] as const

export type GlbSceneResourceField = (typeof GLB_SCENE_RESOURCE_FIELDS)[number]
export type GlbSceneResourceTotals = Record<GlbSceneResourceField, number>
export type GlbSceneResourceReservation = Readonly<GlbValidationSummary>

export const GLB_SCENE_RESOURCE_LIMITS: Readonly<GlbSceneResourceTotals> = {
  decodedAccessorBytes: MAX_GLB_DECODED_ACCESSOR_BYTES,
  decodedTexturePixels: MAX_GLB_TEXTURE_PIXELS,
  residentTexturePixels: MAX_GLB_TEXTURE_PIXELS,
  nodes: MAX_GLB_NODES,
  meshPrimitives: MAX_GLB_MESH_PRIMITIVES,
  primitiveInstances: MAX_GLB_PRIMITIVE_INSTANCES,
  instantiatedDrawElements: MAX_GLB_INSTANTIATED_DRAW_ELEMENTS,
  instantiatedMorphWork: MAX_GLB_INSTANTIATED_MORPH_WORK,
  morphTextureBytes: MAX_GLB_MORPH_TEXTURE_BYTES,
  graphVisits: MAX_GLB_GRAPH_VISITS,
  animationChannels: MAX_GLB_ANIMATION_CHANNELS,
  animationKeyframes: MAX_GLB_ANIMATION_KEYFRAMES,
  animationTracks: MAX_GLB_ANIMATION_TRACKS,
  animationWorkComponents: MAX_GLB_ANIMATION_WORK_COMPONENTS,
  metadataCloneBytes: MAX_GLB_METADATA_CLONE_BYTES,
}

const RESOURCE_LABELS: Readonly<Record<GlbSceneResourceField, string>> = {
  decodedAccessorBytes: 'decoded accessor bytes',
  decodedTexturePixels: 'decoded texture pixels',
  residentTexturePixels: 'resident texture pixels',
  nodes: 'nodes',
  meshPrimitives: 'mesh primitives',
  primitiveInstances: 'primitive instances',
  instantiatedDrawElements: 'instantiated draw elements',
  instantiatedMorphWork: 'instantiated morph work',
  morphTextureBytes: 'expanded morph texture bytes',
  graphVisits: 'scene graph visits',
  animationChannels: 'animation channels',
  animationKeyframes: 'animation keyframes',
  animationTracks: 'animation tracks',
  animationWorkComponents: 'animation work components',
  metadataCloneBytes: 'expanded metadata bytes',
}

function checkedResourceValue(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

function checkedResourceSum(left: number, right: number, name: string): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new Error(`${name} exceeds safe integer bounds`)
  return sum
}

export function sumGlbSceneSourceBytes(
  loaded: readonly number[],
  pending: ReadonlyMap<symbol, number>,
  excludingPending?: symbol
): number {
  let total = 0
  const add = (bytes: number, source: string): void => {
    total = checkedResourceSum(total, checkedResourceValue(bytes, source), 'Scene GLB source bytes')
  }
  loaded.forEach((bytes, index) => add(bytes, `Loaded GLB ${index} source bytes`))
  for (const [token, bytes] of pending) {
    if (token !== excludingPending) add(bytes, 'Pending GLB source bytes')
  }
  return total
}

/** Atomically install or replace one source-byte reservation. */
export function reserveGlbSceneSourceBytes(
  loaded: readonly number[],
  pending: Map<symbol, number>,
  token: symbol,
  candidateBytes: number
): void {
  const candidate = checkedResourceValue(candidateBytes, 'Candidate GLB source bytes')
  if (candidate > MAX_GLB_SOURCE_BYTES) {
    throw new Error(`Asset exceeds maximum size of ${MAX_GLB_SOURCE_BYTES} bytes`)
  }
  const prospective = checkedResourceSum(
    sumGlbSceneSourceBytes(loaded, pending, token),
    candidate,
    'Scene GLB source bytes'
  )
  if (prospective > MAX_GLB_SCENE_SOURCE_BYTES) {
    throw new Error(`Scene GLB sources exceed ${MAX_GLB_SCENE_SOURCE_BYTES} aggregate bytes`)
  }
  pending.set(token, candidate)
}

export function sumGlbSceneResources(
  loaded: readonly GlbSceneResourceReservation[],
  pending: ReadonlyMap<symbol, GlbSceneResourceReservation>,
  excludingPending?: symbol
): GlbSceneResourceTotals {
  const totals = Object.fromEntries(
    GLB_SCENE_RESOURCE_FIELDS.map((field) => [field, 0])
  ) as GlbSceneResourceTotals
  const add = (summary: GlbSceneResourceReservation, source: string): void => {
    for (const field of GLB_SCENE_RESOURCE_FIELDS) {
      totals[field] = checkedResourceSum(
        totals[field],
        checkedResourceValue(summary[field], `${source} ${field}`),
        `Aggregate GLB ${field}`
      )
    }
  }
  loaded.forEach((summary, index) => add(summary, `Loaded GLB ${index}`))
  for (const [token, summary] of pending) {
    if (token !== excludingPending) add(summary, 'Pending GLB')
  }
  return totals
}

/**
 * Check every aggregate resource dimension before mutating the reservation map.
 * JavaScript execution is synchronous here, so concurrent async loaders cannot
 * interleave between the admission decision and the reservation write.
 */
export function reserveGlbSceneResources(
  loaded: readonly GlbSceneResourceReservation[],
  pending: Map<symbol, GlbSceneResourceReservation>,
  token: symbol,
  candidate: GlbSceneResourceReservation
): void {
  const totals = sumGlbSceneResources(loaded, pending, token)
  for (const field of GLB_SCENE_RESOURCE_FIELDS) {
    const prospective = checkedResourceSum(
      totals[field],
      checkedResourceValue(candidate[field], `Candidate GLB ${field}`),
      `Aggregate GLB ${field}`
    )
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    if (prospective > limit) {
      throw new Error(`Scene GLB ${RESOURCE_LABELS[field]} exceed ${limit} aggregate units`)
    }
  }
  pending.set(token, candidate)
}
