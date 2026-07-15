import { describe, expect, it } from 'vitest'
import type { GlbValidationSummary } from '../glbValidation'
import {
  GLB_SCENE_RESOURCE_LIMITS,
  MAX_GLB_SCENE_SOURCE_BYTES,
  MAX_GLB_SOURCE_BYTES,
  reserveGlbSceneResources,
  reserveGlbSceneSourceBytes,
  sumGlbSceneSourceBytes,
  sumGlbSceneResources,
  type GlbSceneResourceField,
} from '../glbSceneBudget'

function summary(field?: GlbSceneResourceField, value = 0): GlbValidationSummary {
  return {
    decodedAccessorBytes: field === 'decodedAccessorBytes' ? value : 0,
    decodedTexturePixels: field === 'decodedTexturePixels' ? value : 0,
    residentTexturePixels: field === 'residentTexturePixels' ? value : 0,
    referencedImages: 0,
    inspectedImageSpans: 0,
    nodes: field === 'nodes' ? value : 0,
    meshPrimitives: field === 'meshPrimitives' ? value : 0,
    primitiveInstances: field === 'primitiveInstances' ? value : 0,
    instantiatedDrawElements: field === 'instantiatedDrawElements' ? value : 0,
    instantiatedMorphWork: field === 'instantiatedMorphWork' ? value : 0,
    morphTextureBytes: field === 'morphTextureBytes' ? value : 0,
    graphVisits: field === 'graphVisits' ? value : 0,
    animationChannels: field === 'animationChannels' ? value : 0,
    animationKeyframes: field === 'animationKeyframes' ? value : 0,
    animationTracks: field === 'animationTracks' ? value : 0,
    animationWorkComponents: field === 'animationWorkComponents' ? value : 0,
    metadataCloneBytes: field === 'metadataCloneBytes' ? value : 0,
  }
}

describe('GLB scene resource reservations', () => {
  it('admits multiple assets exactly to an aggregate resource ceiling', () => {
    const field = 'residentTexturePixels'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const first = summary(field, Math.floor(limit / 2))
    const second = summary(field, limit - first[field])
    const pending = new Map<symbol, GlbValidationSummary>()

    reserveGlbSceneResources([], pending, Symbol('first'), first)
    reserveGlbSceneResources([], pending, Symbol('second'), second)

    expect(sumGlbSceneResources([], pending)[field]).toBe(limit)
  })

  it('counts loaded and pending assets before admitting another asset', () => {
    const field = 'decodedAccessorBytes'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const loaded = [summary(field, Math.floor(limit / 3))]
    const pending = new Map<symbol, GlbValidationSummary>([
      [Symbol('pending'), summary(field, Math.floor(limit / 3))],
    ])

    expect(() =>
      reserveGlbSceneResources(
        loaded,
        pending,
        Symbol('candidate'),
        summary(field, Math.ceil(limit / 3) + 1)
      )
    ).toThrow('decoded accessor bytes exceed')
  })

  it('does not partially reserve a candidate that fails any dimension', () => {
    const field = 'nodes'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const acceptedToken = Symbol('accepted')
    const rejectedToken = Symbol('rejected')
    const pending = new Map<symbol, GlbValidationSummary>()
    reserveGlbSceneResources([], pending, acceptedToken, summary(field, limit))

    expect(() => reserveGlbSceneResources([], pending, rejectedToken, summary(field, 1))).toThrow(
      'nodes exceed'
    )
    expect(pending.size).toBe(1)
    expect(pending.has(rejectedToken)).toBe(false)
  })

  it('allows a failed or completed parse reservation to be released and reused', () => {
    const field = 'meshPrimitives'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const firstToken = Symbol('failed parse')
    const replacementToken = Symbol('replacement')
    const pending = new Map<symbol, GlbValidationSummary>()
    const candidate = summary(field, limit)

    reserveGlbSceneResources([], pending, firstToken, candidate)
    pending.delete(firstToken)
    expect(() => reserveGlbSceneResources([], pending, replacementToken, candidate)).not.toThrow()
  })

  it('recomputes from the current loaded set so accepted-asset removal frees capacity', () => {
    const field = 'metadataCloneBytes'
    const candidate = summary(field, GLB_SCENE_RESOURCE_LIMITS[field])
    const pending = new Map<symbol, GlbValidationSummary>()

    expect(() =>
      reserveGlbSceneResources([candidate], pending, Symbol('blocked'), summary(field, 1))
    ).toThrow('expanded metadata bytes exceed')
    expect(() =>
      reserveGlbSceneResources([], pending, Symbol('after removal'), candidate)
    ).not.toThrow()
  })

  it('retains a cancelled non-abortable parse reservation until that parse settles', () => {
    const field = 'decodedAccessorBytes'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const parseToken = Symbol('non-abortable parse')
    const pending = new Map<symbol, GlbValidationSummary>()
    reserveGlbSceneResources([], pending, parseToken, summary(field, limit))

    // A generation reset fences the result but cannot stop GLTFLoader.parse.
    expect(() =>
      reserveGlbSceneResources([], pending, Symbol('while stale parse runs'), summary(field, 1))
    ).toThrow('decoded accessor bytes exceed')
    expect(pending.has(parseToken)).toBe(true)

    pending.delete(parseToken)
    expect(() =>
      reserveGlbSceneResources([], pending, Symbol('after parse settles'), summary(field, limit))
    ).not.toThrow()
  })

  it('serializes concurrent admissions so only one over-half candidate wins', async () => {
    const field = 'instantiatedMorphWork'
    const limit = GLB_SCENE_RESOURCE_LIMITS[field]
    const candidate = summary(field, Math.floor(limit / 2) + 1)
    const pending = new Map<symbol, GlbValidationSummary>()
    const attempt = (name: string) =>
      Promise.resolve().then(() => {
        reserveGlbSceneResources([], pending, Symbol(name), candidate)
      })

    const results = await Promise.allSettled([attempt('first'), attempt('second')])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(pending.size).toBe(1)
  })

  it('pre-reserves URL GLBs before acquisition and atomically shrinks to actual bytes', () => {
    const pending = new Map<symbol, number>()
    const tokens = Array.from({ length: 4 }, (_, index) => Symbol(`download ${index}`))
    for (const token of tokens) {
      reserveGlbSceneSourceBytes([], pending, token, MAX_GLB_SOURCE_BYTES)
    }
    expect(sumGlbSceneSourceBytes([], pending)).toBe(MAX_GLB_SCENE_SOURCE_BYTES)
    expect(() => reserveGlbSceneSourceBytes([], pending, Symbol('fifth download'), 1)).toThrow(
      'aggregate bytes'
    )

    reserveGlbSceneSourceBytes([], pending, tokens[0], 1)
    expect(() =>
      reserveGlbSceneSourceBytes(
        [],
        pending,
        Symbol('after actual length'),
        MAX_GLB_SOURCE_BYTES - 1
      )
    ).not.toThrow()
  })
})
