import type { ValidatedAccessor } from './glbValidation'

export const MAX_GLB_ANIMATIONS = 256
export const MAX_GLB_ANIMATION_SAMPLERS_PER_ANIMATION = 1024
export const MAX_GLB_ANIMATION_SAMPLERS = 4096
export const MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION = 1024
export const MAX_GLB_ANIMATION_CHANNELS = 4096
export const MAX_GLB_ANIMATION_TRACKS = 8192
export const MAX_GLB_ANIMATION_KEYFRAMES = 1_048_576
export const MAX_GLB_ANIMATION_WORK_COMPONENTS = 16_777_216

type JsonRecord = Record<string, unknown>

interface AnimationGraph {
  morphPrimitiveCounts: number[]
  morphTargetCounts: number[]
  nodes: JsonRecord[]
}

export interface AnimationValidationSummary {
  channels: number
  keyframes: number
  tracks: number
  workComponents: number
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function checkedProduct(left: number, right: number, name: string): number {
  const product = left * right
  if (!Number.isSafeInteger(product)) throw new Error(`${name} exceeds safe integer bounds`)
  return product
}

function checkedSum(left: number, right: number, name: string): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new Error(`${name} exceeds safe integer bounds`)
  return sum
}

function boundedArray(value: unknown, name: string, maximum: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`GLB may contain at most ${maximum} ${name}`)
  }
  return value
}

function requiredBoundedArray(value: unknown, name: string, maximum: number): unknown[] {
  const array = boundedArray(value, name, maximum)
  if (array.length === 0) throw new Error(`GLB ${name} must be a non-empty array`)
  return array
}

function boundedRecordArray(value: unknown, name: string, maximum: number): JsonRecord[] {
  const array = boundedArray(value, name, maximum)
  return array.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`GLB ${name} ${index} is invalid`)
    return entry
  })
}

function referencedIndex(value: unknown, length: number, name: string): number {
  const index = safeInteger(value, name)
  if (index >= length) throw new Error(`${name} references an invalid index`)
  return index
}

function animationOutputMultiplier(interpolation: string, name: string): number {
  if (interpolation === 'LINEAR' || interpolation === 'STEP') return 1
  if (interpolation === 'CUBICSPLINE') return 3
  throw new Error(`${name} interpolation is unsupported`)
}

export function validateAnimations(
  manifest: JsonRecord,
  accessors: ValidatedAccessor[],
  graph: AnimationGraph
): AnimationValidationSummary {
  const animations = boundedRecordArray(manifest.animations, 'animations', MAX_GLB_ANIMATIONS)
  let totalSamplers = 0
  let totalChannels = 0
  let totalTracks = 0
  let totalKeyframes = 0
  let totalWorkComponents = 0

  for (const [animationIndex, animation] of animations.entries()) {
    const samplers = requiredBoundedArray(
      animation.samplers,
      `animation ${animationIndex} samplers`,
      MAX_GLB_ANIMATION_SAMPLERS_PER_ANIMATION
    )
    const channels = requiredBoundedArray(
      animation.channels,
      `animation ${animationIndex} channels`,
      MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION
    )
    totalSamplers = checkedSum(totalSamplers, samplers.length, 'GLB animation samplers')
    if (totalSamplers > MAX_GLB_ANIMATION_SAMPLERS) {
      throw new Error(`GLB may contain at most ${MAX_GLB_ANIMATION_SAMPLERS} animation samplers`)
    }
    totalChannels = checkedSum(totalChannels, channels.length, 'GLB animation channels')
    if (totalChannels > MAX_GLB_ANIMATION_CHANNELS) {
      throw new Error(`GLB may contain at most ${MAX_GLB_ANIMATION_CHANNELS} animation channels`)
    }

    const validatedSamplers = samplers.map((rawSampler, samplerIndex) => {
      if (!isRecord(rawSampler)) {
        throw new Error(`GLB animation ${animationIndex} sampler ${samplerIndex} is invalid`)
      }
      const inputIndex = referencedIndex(
        rawSampler.input,
        accessors.length,
        `GLB animation ${animationIndex} sampler ${samplerIndex} input`
      )
      const outputIndex = referencedIndex(
        rawSampler.output,
        accessors.length,
        `GLB animation ${animationIndex} sampler ${samplerIndex} output`
      )
      const input = accessors[inputIndex]
      if (input.type !== 'SCALAR' || input.componentType !== 5126) {
        throw new Error(
          `GLB animation ${animationIndex} sampler ${samplerIndex} input must be FLOAT SCALAR`
        )
      }
      const interpolation = rawSampler.interpolation ?? 'LINEAR'
      if (typeof interpolation !== 'string') {
        throw new Error(
          `GLB animation ${animationIndex} sampler ${samplerIndex} interpolation is invalid`
        )
      }
      return {
        input,
        output: accessors[outputIndex],
        outputMultiplier: animationOutputMultiplier(
          interpolation,
          `GLB animation ${animationIndex} sampler ${samplerIndex}`
        ),
      }
    })

    for (const [channelIndex, rawChannel] of channels.entries()) {
      if (!isRecord(rawChannel) || !isRecord(rawChannel.target)) {
        throw new Error(`GLB animation ${animationIndex} channel ${channelIndex} is invalid`)
      }
      const name = `GLB animation ${animationIndex} channel ${channelIndex}`
      const samplerIndex = referencedIndex(
        rawChannel.sampler,
        validatedSamplers.length,
        `${name} sampler`
      )
      const sampler = validatedSamplers[samplerIndex]
      const targetNode = referencedIndex(
        rawChannel.target.node,
        graph.nodes.length,
        `${name} target node`
      )
      const targetPath = rawChannel.target.path
      if (
        targetPath !== 'translation' &&
        targetPath !== 'rotation' &&
        targetPath !== 'scale' &&
        targetPath !== 'weights'
      ) {
        throw new Error(`${name} target path is unsupported`)
      }

      let trackMultiplier = 1
      let expectedOutputType: string = targetPath === 'rotation' ? 'VEC4' : 'VEC3'
      let expectedOutputCount = checkedProduct(
        sampler.input.count,
        sampler.outputMultiplier,
        `${name} output count`
      )
      if (targetPath === 'weights') {
        trackMultiplier = graph.morphPrimitiveCounts[targetNode]
        const morphTargetCount = graph.morphTargetCounts[targetNode]
        if (trackMultiplier === 0 || morphTargetCount === 0) {
          throw new Error(`${name} weights target has no morph-target primitives`)
        }
        if (morphTargetCount === -1) {
          throw new Error(`${name} weights target spans incompatible morph-target counts`)
        }
        expectedOutputType = 'SCALAR'
        expectedOutputCount = checkedProduct(
          expectedOutputCount,
          morphTargetCount,
          `${name} weights output count`
        )
      }
      if (
        sampler.output.type !== expectedOutputType ||
        sampler.output.count !== expectedOutputCount ||
        sampler.output.componentType !== 5126
      ) {
        throw new Error(
          `${name} output accessor does not match its target path, interpolation, and keyframes`
        )
      }

      totalTracks = checkedSum(totalTracks, trackMultiplier, 'GLB animation tracks')
      if (totalTracks > MAX_GLB_ANIMATION_TRACKS) {
        throw new Error(`GLB animations exceed ${MAX_GLB_ANIMATION_TRACKS} aggregate tracks`)
      }
      const channelKeyframes = checkedProduct(
        sampler.input.count,
        trackMultiplier,
        `${name} keyframes`
      )
      totalKeyframes = checkedSum(totalKeyframes, channelKeyframes, 'GLB animation keyframes')
      if (totalKeyframes > MAX_GLB_ANIMATION_KEYFRAMES) {
        throw new Error(
          `GLB animations exceed ${MAX_GLB_ANIMATION_KEYFRAMES} aggregate referenced keyframes`
        )
      }
      const outputComponents = checkedProduct(
        sampler.output.count,
        sampler.output.componentCount,
        `${name} output components`
      )
      const channelComponents = checkedSum(
        sampler.input.count,
        outputComponents,
        `${name} work components`
      )
      const channelWork = checkedProduct(
        channelComponents,
        trackMultiplier,
        `${name} track work components`
      )
      totalWorkComponents = checkedSum(
        totalWorkComponents,
        channelWork,
        'GLB animation work components'
      )
      if (totalWorkComponents > MAX_GLB_ANIMATION_WORK_COMPONENTS) {
        throw new Error(
          `GLB animations exceed ${MAX_GLB_ANIMATION_WORK_COMPONENTS} aggregate work components`
        )
      }
    }
  }
  return {
    channels: totalChannels,
    keyframes: totalKeyframes,
    tracks: totalTracks,
    workComponents: totalWorkComponents,
  }
}
