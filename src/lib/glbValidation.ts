import { validateAnimations } from './glbAnimationValidation'
import {
  decodeImageDataUri,
  inspectEncodedImage,
  validateDeclaredImageMimeType,
  type EncodedImageInspection,
} from './glbImageInspection'
import { validateGlbJsonSyntax } from './glbJsonValidation'
import {
  cloneableMetadataByteCounts,
  cloneableMetadataBytes,
  MAX_GLB_METADATA_CLONE_BYTES,
} from './glbMetadataValidation'

export {
  MAX_GLB_ANIMATIONS,
  MAX_GLB_ANIMATION_CHANNELS,
  MAX_GLB_ANIMATION_CHANNELS_PER_ANIMATION,
  MAX_GLB_ANIMATION_KEYFRAMES,
  MAX_GLB_ANIMATION_SAMPLERS,
  MAX_GLB_ANIMATION_SAMPLERS_PER_ANIMATION,
  MAX_GLB_ANIMATION_TRACKS,
  MAX_GLB_ANIMATION_WORK_COMPONENTS,
} from './glbAnimationValidation'
export {
  MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT,
  MAX_GLB_METADATA_CLONE_BYTES,
} from './glbMetadataValidation'
export { inspectPngJpegDimensions } from './glbImageInspection'

const GLB_MAGIC = 0x46546c67
const GLB_VERSION = 2
const JSON_CHUNK_TYPE = 0x4e4f534a
const BIN_CHUNK_TYPE = 0x004e4942
const MAX_EMBEDDED_IMAGES = 256
const MAX_IMAGE_DIMENSION = 8192
const MAX_GLB_JSON_BYTES = 16 * 1024 * 1024
// Above the 100,000-key syntax ceiling and all declared product arrays, while
// bounding transient visited-plus-pending URI traversal work.
const MAX_GLB_URI_SCAN_VALUES = 262_144
const CANONICAL_EMBEDDED_RASTER_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/
export const MAX_GLB_TEXTURE_PIXELS = 16_777_216
export const MAX_GLB_BUFFER_VIEWS = 65_536
export const MAX_GLB_ACCESSORS = 65_536
export const MAX_GLB_ACCESSOR_ELEMENTS = 16_777_216
export const MAX_GLB_DECODED_ACCESSOR_BYTES = 256 * 1024 * 1024
export const MAX_GLB_NODES = 4096
export const MAX_GLB_NODE_HIERARCHY_DEPTH = 128
export const MAX_GLB_SCENES = 64
export const MAX_GLB_SCENE_ROOTS_PER_SCENE = 256
export const MAX_GLB_SCENE_ROOT_REFERENCES = 1024
export const MAX_GLB_GRAPH_VISITS = 16_384
export const MAX_GLB_MESHES = 2048
export const MAX_GLB_PRIMITIVES_PER_MESH = 256
export const MAX_GLB_MESH_PRIMITIVES = 8192
export const MAX_GLB_PRIMITIVE_INSTANCES = 2048
export const MAX_GLB_INSTANTIATED_DRAW_ELEMENTS = 67_108_864
export const MAX_GLB_INSTANTIATED_MORPH_WORK = 67_108_864
export const MAX_GLB_ATTRIBUTES_PER_PRIMITIVE = 32
export const MAX_GLB_PRIMITIVE_ACCESSOR_REFERENCES = 65_536
export const MAX_GLB_GEOMETRY_ELEMENT_REFERENCES = 67_108_864
export const MAX_GLB_MATERIALS = 2048
export const MAX_GLB_TEXTURES = 2048
export const MAX_GLB_TEXTURE_SAMPLERS = 256
export const MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE = 16
export const MAX_GLB_CAMERAS = 256
export const MAX_GLB_MORPH_TARGETS_PER_PRIMITIVE = 64
export const MAX_GLB_MORPH_TARGET_REFERENCES = 16_384
export const MAX_GLB_MORPH_TEXTURE_BYTES = 256 * 1024 * 1024
export const MAX_GLB_SKINS = 256
export const MAX_GLB_JOINTS_PER_SKIN = 512
export const MAX_GLB_SKIN_JOINT_REFERENCES = 8192

export interface GlbValidationSummary {
  decodedAccessorBytes: number
  decodedTexturePixels: number
  residentTexturePixels: number
  referencedImages: number
  inspectedImageSpans: number
  nodes: number
  meshPrimitives: number
  primitiveInstances: number
  instantiatedDrawElements: number
  instantiatedMorphWork: number
  morphTextureBytes: number
  metadataCloneBytes: number
  graphVisits: number
  animationChannels: number
  animationKeyframes: number
  animationTracks: number
  animationWorkComponents: number
}

interface ValidatedBufferView {
  byteOffset: number
  byteLength: number
  byteStride?: number
}

export interface ValidatedAccessor {
  componentCount: number
  componentType: number
  count: number
  type: string
}

interface ValidatedAccessors {
  accessors: ValidatedAccessor[]
  decodedBytes: number
}

interface GlbStructureSummary {
  animationChannels: number
  animationKeyframes: number
  animationTracks: number
  animationWorkComponents: number
  graphVisits: number
  meshPrimitives: number
  nodes: number
  primitiveInstances: number
  instantiatedDrawElements: number
  instantiatedMorphWork: number
  textureVariantCounts: number[]
  morphTextureBytes: number
  metadataCloneBytes: number
}

const ACCESSOR_COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

const ACCESSOR_TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

const UNSUPPORTED_LOADER_AMPLIFICATION_EXTENSIONS = new Set([
  'EXT_mesh_gpu_instancing',
  'EXT_meshopt_compression',
  'KHR_lights_punctual',
  'KHR_draco_mesh_compression',
  'KHR_texture_transform',
])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
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

function referencedIndex(value: unknown, length: number, name: string): number {
  const index = safeInteger(value, name)
  if (index >= length) throw new Error(`${name} references an invalid index`)
  return index
}

function boundedRecordArray(value: unknown, name: string, maximum: number): JsonRecord[] {
  const array = boundedArray(value, name, maximum)
  return array.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`GLB ${name} ${index} is invalid`)
    return entry
  })
}

function rejectExternalUris(value: unknown): void {
  const pending: unknown[] = [value]
  let visits = 0
  while (pending.length > 0) {
    visits += 1
    const current = pending.pop()
    if (Array.isArray(current)) {
      if (current.length > MAX_GLB_URI_SCAN_VALUES - visits - pending.length) {
        throw new Error('GLB resource URI scan exceeds its bounded work limit')
      }
      for (let index = 0; index < current.length; index += 1) pending.push(current[index])
      continue
    }
    if (!isRecord(current)) continue
    const entries = Object.entries(current)
    if (entries.length > MAX_GLB_URI_SCAN_VALUES - visits - pending.length) {
      throw new Error('GLB resource URI scan exceeds its bounded work limit')
    }
    for (const [key, child] of entries) {
      if (
        key === 'uri' &&
        (typeof child !== 'string' || !CANONICAL_EMBEDDED_RASTER_URI.test(child))
      ) {
        throw new Error(
          'GLB references an external resource or a non-canonical embedded resource; package every resource into the GLB'
        )
      }
      pending.push(child)
    }
  }
}

function rejectUnsupportedLoaderAmplification(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectUnsupportedLoaderAmplification)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_LOADER_AMPLIFICATION_EXTENSIONS.has(key)) {
      throw new Error(`GLB extension ${key} is outside the bounded loader profile`)
    }
    rejectUnsupportedLoaderAmplification(child)
  }
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

function accessorElementBytes(type: string, componentBytes: number): number {
  const componentCount = ACCESSOR_TYPE_COMPONENTS[type]
  if (!componentCount) throw new Error(`GLB accessor type ${type} is unsupported`)

  // glTF pads each matrix column to a four-byte boundary when 8/16-bit
  // components would otherwise leave it unaligned.
  if (type === 'MAT2' || type === 'MAT3' || type === 'MAT4') {
    const columns = Number(type.at(-1))
    const columnBytes = columns * componentBytes
    const alignedColumnBytes = Math.ceil(columnBytes / 4) * 4
    return columns * alignedColumnBytes
  }
  return componentCount * componentBytes
}

function validateSpan(
  bufferView: ValidatedBufferView,
  byteOffset: number,
  count: number,
  elementBytes: number,
  stride: number,
  name: string
): void {
  const span =
    count === 0
      ? byteOffset
      : checkedSum(
          byteOffset,
          checkedSum(
            checkedProduct(count - 1, stride, `${name} stride span`),
            elementBytes,
            `${name} element span`
          ),
          `${name} span`
        )
  if (span > bufferView.byteLength) throw new Error(`${name} exceeds its bufferView`)
}

function validateBuffersAndViews(
  manifest: JsonRecord,
  binBytes: Uint8Array | null
): ValidatedBufferView[] {
  const rawBuffers = manifest.buffers
  let declaredBufferBytes = 0
  if (rawBuffers !== undefined) {
    if (
      !Array.isArray(rawBuffers) ||
      rawBuffers.length !== 1 ||
      !isRecord(rawBuffers[0]) ||
      typeof rawBuffers[0].uri === 'string'
    ) {
      throw new Error('GLB must use one embedded binary buffer')
    }
    declaredBufferBytes = safeInteger(rawBuffers[0].byteLength, 'GLB buffer byteLength')
    if (!binBytes || binBytes.byteLength < declaredBufferBytes) {
      throw new Error('GLB embedded buffer exceeds the binary chunk')
    }
    if (binBytes.byteLength - declaredBufferBytes > 3) {
      throw new Error('GLB binary chunk exceeds its declared buffer padding')
    }
  } else if (binBytes) {
    throw new Error('GLB binary chunk has no declared embedded buffer')
  }

  const rawBufferViews = manifest.bufferViews
  if (rawBufferViews === undefined) return []
  if (!Array.isArray(rawBufferViews) || rawBufferViews.length > MAX_GLB_BUFFER_VIEWS) {
    throw new Error(`GLB may contain at most ${MAX_GLB_BUFFER_VIEWS} bufferViews`)
  }

  return rawBufferViews.map((rawBufferView, index) => {
    if (!isRecord(rawBufferView)) throw new Error(`GLB bufferView ${index} is invalid`)
    if (safeInteger(rawBufferView.buffer ?? 0, `GLB bufferView ${index} buffer`) !== 0) {
      throw new Error(`GLB bufferView ${index} references a non-embedded buffer`)
    }
    const byteOffset = safeInteger(
      rawBufferView.byteOffset ?? 0,
      `GLB bufferView ${index} byteOffset`
    )
    const byteLength = safeInteger(rawBufferView.byteLength, `GLB bufferView ${index} byteLength`)
    if (byteLength === 0) throw new Error(`GLB bufferView ${index} byteLength must be positive`)
    const end = checkedSum(byteOffset, byteLength, `GLB bufferView ${index}`)
    if (end > declaredBufferBytes) throw new Error(`GLB bufferView ${index} exceeds the buffer`)

    let byteStride: number | undefined
    if (rawBufferView.byteStride !== undefined) {
      byteStride = safeInteger(rawBufferView.byteStride, `GLB bufferView ${index} byteStride`)
      if (byteStride < 4 || byteStride > 252 || byteStride % 4 !== 0) {
        throw new Error(`GLB bufferView ${index} byteStride must be a multiple of 4 within 4-252`)
      }
    }
    return { byteOffset, byteLength, byteStride }
  })
}

function validateSparseIndices(
  binBytes: Uint8Array,
  bufferView: ValidatedBufferView,
  byteOffset: number,
  sparseCount: number,
  indexComponentType: number,
  accessorCount: number,
  name: string
): void {
  const absoluteOffset = bufferView.byteOffset + byteOffset
  const indexBytes = ACCESSOR_COMPONENT_BYTES[indexComponentType]
  const view = new DataView(
    binBytes.buffer,
    binBytes.byteOffset + absoluteOffset,
    sparseCount * indexBytes
  )
  let previousIndex = -1
  for (let index = 0; index < sparseCount; index += 1) {
    const offset = index * indexBytes
    const sparseIndex =
      indexComponentType === 5121
        ? view.getUint8(offset)
        : indexComponentType === 5123
          ? view.getUint16(offset, true)
          : view.getUint32(offset, true)
    if (sparseIndex >= accessorCount) throw new Error(`${name} sparse index exceeds accessor.count`)
    if (sparseIndex <= previousIndex) {
      throw new Error(`${name} sparse indices must be strictly increasing`)
    }
    previousIndex = sparseIndex
  }
}

function validateAccessors(
  manifest: JsonRecord,
  bufferViews: ValidatedBufferView[],
  binBytes: Uint8Array | null
): ValidatedAccessors {
  const rawAccessors = manifest.accessors
  if (rawAccessors === undefined) return { accessors: [], decodedBytes: 0 }
  if (!Array.isArray(rawAccessors) || rawAccessors.length > MAX_GLB_ACCESSORS) {
    throw new Error(`GLB may contain at most ${MAX_GLB_ACCESSORS} accessors`)
  }

  let decodedBytes = 0
  const accessors: ValidatedAccessor[] = []
  for (const [accessorIndex, rawAccessor] of rawAccessors.entries()) {
    if (!isRecord(rawAccessor)) throw new Error(`GLB accessor ${accessorIndex} is invalid`)
    const name = `GLB accessor ${accessorIndex}`
    const count = safeInteger(rawAccessor.count, `${name} count`)
    if (count < 1 || count > MAX_GLB_ACCESSOR_ELEMENTS) {
      throw new Error(`${name} count must be within 1-${MAX_GLB_ACCESSOR_ELEMENTS}`)
    }
    const componentType = safeInteger(rawAccessor.componentType, `${name} componentType`)
    const componentBytes = ACCESSOR_COMPONENT_BYTES[componentType]
    if (!componentBytes) throw new Error(`${name} componentType is unsupported`)
    if (typeof rawAccessor.type !== 'string') throw new Error(`${name} type is invalid`)
    const elementBytes = accessorElementBytes(rawAccessor.type, componentBytes)
    const componentCount = ACCESSOR_TYPE_COMPONENTS[rawAccessor.type]
    const accessorBytes = checkedProduct(count, elementBytes, `${name} decoded bytes`)
    decodedBytes = checkedSum(decodedBytes, accessorBytes, 'GLB decoded accessor bytes')
    if (decodedBytes > MAX_GLB_DECODED_ACCESSOR_BYTES) {
      throw new Error(
        `GLB decoded accessors exceed ${MAX_GLB_DECODED_ACCESSOR_BYTES} aggregate bytes`
      )
    }
    if (rawAccessor.normalized !== undefined && typeof rawAccessor.normalized !== 'boolean') {
      throw new Error(`${name} normalized must be boolean`)
    }

    const accessorByteOffset = safeInteger(rawAccessor.byteOffset ?? 0, `${name} byteOffset`)
    if (accessorByteOffset % componentBytes !== 0) {
      throw new Error(`${name} byteOffset is not component-aligned`)
    }
    if (rawAccessor.bufferView !== undefined) {
      const bufferViewIndex = safeInteger(rawAccessor.bufferView, `${name} bufferView`)
      const bufferView = bufferViews[bufferViewIndex]
      if (!bufferView) throw new Error(`${name} references an invalid bufferView`)
      if ((bufferView.byteOffset + accessorByteOffset) % componentBytes !== 0) {
        throw new Error(`${name} is not component-aligned within the buffer`)
      }
      const stride = bufferView.byteStride ?? elementBytes
      if (stride < elementBytes || stride % componentBytes !== 0) {
        throw new Error(`${name} bufferView stride cannot contain its element`)
      }
      validateSpan(bufferView, accessorByteOffset, count, elementBytes, stride, name)
    } else if (rawAccessor.sparse === undefined) {
      throw new Error(`${name} must reference a bufferView or define sparse values`)
    } else if (accessorByteOffset !== 0) {
      throw new Error(`${name} without a bufferView cannot define byteOffset`)
    }

    if (rawAccessor.sparse !== undefined) {
      if (!isRecord(rawAccessor.sparse)) throw new Error(`${name} sparse value is invalid`)
      const sparseCount = safeInteger(rawAccessor.sparse.count, `${name} sparse count`)
      if (sparseCount < 1 || sparseCount > count) {
        throw new Error(`${name} sparse count must be within 1-accessor.count`)
      }
      if (!isRecord(rawAccessor.sparse.indices) || !isRecord(rawAccessor.sparse.values)) {
        throw new Error(`${name} sparse indices/values are invalid`)
      }

      const indices = rawAccessor.sparse.indices
      const sparseIndexType = safeInteger(indices.componentType, `${name} sparse index type`)
      if (sparseIndexType !== 5121 && sparseIndexType !== 5123 && sparseIndexType !== 5125) {
        throw new Error(`${name} sparse index type is unsupported`)
      }
      const sparseIndexBytes = ACCESSOR_COMPONENT_BYTES[sparseIndexType]
      const indicesViewIndex = safeInteger(indices.bufferView, `${name} sparse indices bufferView`)
      const indicesView = bufferViews[indicesViewIndex]
      if (!indicesView || indicesView.byteStride !== undefined) {
        throw new Error(`${name} sparse indices require a packed bufferView`)
      }
      const indicesOffset = safeInteger(indices.byteOffset ?? 0, `${name} sparse indices offset`)
      if (indicesOffset % sparseIndexBytes !== 0) {
        throw new Error(`${name} sparse indices offset is not component-aligned`)
      }
      if ((indicesView.byteOffset + indicesOffset) % sparseIndexBytes !== 0) {
        throw new Error(`${name} sparse indices are not component-aligned within the buffer`)
      }
      validateSpan(
        indicesView,
        indicesOffset,
        sparseCount,
        sparseIndexBytes,
        sparseIndexBytes,
        `${name} sparse indices`
      )
      if (!binBytes) throw new Error(`${name} sparse indices require an embedded buffer`)
      validateSparseIndices(
        binBytes,
        indicesView,
        indicesOffset,
        sparseCount,
        sparseIndexType,
        count,
        name
      )

      const values = rawAccessor.sparse.values
      const valuesViewIndex = safeInteger(values.bufferView, `${name} sparse values bufferView`)
      const valuesView = bufferViews[valuesViewIndex]
      if (!valuesView || valuesView.byteStride !== undefined) {
        throw new Error(`${name} sparse values require a packed bufferView`)
      }
      const valuesOffset = safeInteger(values.byteOffset ?? 0, `${name} sparse values offset`)
      if (valuesOffset % componentBytes !== 0) {
        throw new Error(`${name} sparse values offset is not component-aligned`)
      }
      if ((valuesView.byteOffset + valuesOffset) % componentBytes !== 0) {
        throw new Error(`${name} sparse values are not component-aligned within the buffer`)
      }
      validateSpan(
        valuesView,
        valuesOffset,
        sparseCount,
        elementBytes,
        elementBytes,
        `${name} sparse values`
      )

      const sparseWorkingBytes = checkedProduct(
        sparseCount,
        sparseIndexBytes + elementBytes,
        `${name} sparse working bytes`
      )
      decodedBytes = checkedSum(decodedBytes, sparseWorkingBytes, 'GLB decoded accessor bytes')
      if (decodedBytes > MAX_GLB_DECODED_ACCESSOR_BYTES) {
        throw new Error(
          `GLB decoded accessors exceed ${MAX_GLB_DECODED_ACCESSOR_BYTES} aggregate bytes`
        )
      }
    }
    accessors.push({ componentCount, componentType, count, type: rawAccessor.type })
  }
  return { accessors, decodedBytes }
}

interface ValidatedMeshStructure {
  drawElementCounts: number[]
  metadataCloneBytes: number[]
  morphWorkElementCounts: number[]
  morphPrimitiveCounts: number[]
  morphTargetCounts: number[]
  primitiveCounts: number[]
  staticMetadataCloneBytes: number
  morphTextureBytes: number
  totalPrimitives: number
}

function validateMaterialTextureReferences(
  value: unknown,
  textureCount: number,
  path: string
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateMaterialTextureReferences(entry, textureCount, `${path}[${index}]`)
    )
    return
  }
  if (!isRecord(value)) return

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (/texture$/i.test(key) && isRecord(child) && child.index !== undefined) {
      referencedIndex(child.index, textureCount, `${childPath}.index`)
      if (
        child.texCoord !== undefined &&
        safeInteger(child.texCoord, `${childPath}.texCoord`) !== 0
      ) {
        throw new Error(`${childPath}.texCoord must be 0 in the bounded loader profile`)
      }
    }
    validateMaterialTextureReferences(child, textureCount, childPath)
  }
}

interface ValidatedMaterialTextureStructure {
  materialCount: number
  materialMetadataBytes: number[]
  textureVariantCounts: number[]
}

const GLTF_MAG_FILTERS = new Set([9728, 9729])
const GLTF_MIN_FILTERS = new Set([9728, 9729, 9984, 9985, 9986, 9987])
const GLTF_WRAP_MODES = new Set([33071, 33648, 10497])

function samplerEnum(
  value: unknown,
  fallback: number,
  supported: ReadonlySet<number>,
  name: string
): number {
  if (value === undefined) return fallback
  const candidate = safeInteger(value, name)
  if (!supported.has(candidate)) throw new Error(`${name} is unsupported`)
  return candidate
}

function validateMaterialAndTextureStructure(
  manifest: JsonRecord
): ValidatedMaterialTextureStructure {
  const images = boundedRecordArray(manifest.images, 'embedded images', MAX_EMBEDDED_IMAGES)
  const samplers = boundedRecordArray(
    manifest.samplers,
    'texture samplers',
    MAX_GLB_TEXTURE_SAMPLERS
  )
  samplers.forEach((sampler, samplerIndex) => {
    samplerEnum(
      sampler.magFilter,
      9729,
      GLTF_MAG_FILTERS,
      `GLB texture sampler ${samplerIndex} magFilter`
    )
    samplerEnum(
      sampler.minFilter,
      9987,
      GLTF_MIN_FILTERS,
      `GLB texture sampler ${samplerIndex} minFilter`
    )
    samplerEnum(sampler.wrapS, 10497, GLTF_WRAP_MODES, `GLB texture sampler ${samplerIndex} wrapS`)
    samplerEnum(sampler.wrapT, 10497, GLTF_WRAP_MODES, `GLB texture sampler ${samplerIndex} wrapT`)
  })
  const textures = boundedRecordArray(manifest.textures, 'textures', MAX_GLB_TEXTURES)
  const variantsByImage = Array.from({ length: images.length }, () => new Set<string>())
  for (const [textureIndex, texture] of textures.entries()) {
    const sourceIndex = referencedIndex(
      texture.source,
      images.length,
      `GLB texture ${textureIndex} source`
    )
    let samplerKey = 'sampler:undefined'
    if (texture.sampler !== undefined) {
      const samplerIndex = referencedIndex(
        texture.sampler,
        samplers.length,
        `GLB texture ${textureIndex} sampler`
      )
      // GLTFLoader keys its texture cache by sampler index, not by the
      // sampler's effective enum values. Equal definitions at distinct
      // indices therefore remain distinct GPU texture identities.
      samplerKey = `sampler:${samplerIndex}`
    }
    const variants = variantsByImage[sourceIndex]
    variants.add(samplerKey)
    if (variants.size > MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE) {
      throw new Error(
        `GLB image ${sourceIndex} exceeds ${MAX_GLB_TEXTURE_VARIANTS_PER_IMAGE} loader texture identities`
      )
    }
  }

  const materials = boundedRecordArray(manifest.materials, 'materials', MAX_GLB_MATERIALS)
  const materialMetadataBytes: number[] = []
  for (const [materialIndex, material] of materials.entries()) {
    materialMetadataBytes.push(cloneableMetadataBytes(material, `GLB material ${materialIndex}`))
    validateMaterialTextureReferences(material, textures.length, `GLB material ${materialIndex}`)
  }
  return {
    materialCount: materials.length,
    materialMetadataBytes,
    textureVariantCounts: variantsByImage.map((variants) => variants.size),
  }
}

function chargePrimitiveAccessor(
  value: unknown,
  accessors: ValidatedAccessor[],
  name: string,
  counters: { elementReferences: number; references: number }
): ValidatedAccessor {
  const accessorIndex = referencedIndex(value, accessors.length, name)
  const accessor = accessors[accessorIndex]
  counters.references = checkedSum(counters.references, 1, 'GLB primitive accessor references')
  if (counters.references > MAX_GLB_PRIMITIVE_ACCESSOR_REFERENCES) {
    throw new Error(
      `GLB primitives exceed ${MAX_GLB_PRIMITIVE_ACCESSOR_REFERENCES} aggregate accessor references`
    )
  }
  counters.elementReferences = checkedSum(
    counters.elementReferences,
    accessor.count,
    'GLB geometry element references'
  )
  if (counters.elementReferences > MAX_GLB_GEOMETRY_ELEMENT_REFERENCES) {
    throw new Error(
      `GLB primitives exceed ${MAX_GLB_GEOMETRY_ELEMENT_REFERENCES} aggregate geometry element references`
    )
  }
  return accessor
}

function validatePrimitiveAttributes(
  rawAttributes: unknown,
  accessors: ValidatedAccessor[],
  name: string,
  counters: { elementReferences: number; references: number }
): number {
  if (!isRecord(rawAttributes)) throw new Error(`${name} attributes must be an object`)
  const attributes = Object.entries(rawAttributes)
  if (attributes.length === 0 || attributes.length > MAX_GLB_ATTRIBUTES_PER_PRIMITIVE) {
    throw new Error(`${name} must define 1-${MAX_GLB_ATTRIBUTES_PER_PRIMITIVE} vertex attributes`)
  }

  let vertexCount = -1
  for (const [semantic, accessorIndex] of attributes) {
    const accessor = chargePrimitiveAccessor(
      accessorIndex,
      accessors,
      `${name} attribute ${semantic}`,
      counters
    )
    if (vertexCount === -1) vertexCount = accessor.count
    if (accessor.count !== vertexCount) {
      throw new Error(`${name} vertex attributes must have the same accessor count`)
    }
  }
  return vertexCount
}

function validateMeshStructure(
  manifest: JsonRecord,
  accessors: ValidatedAccessor[],
  materials: ValidatedMaterialTextureStructure
): ValidatedMeshStructure {
  const meshes = boundedRecordArray(manifest.meshes, 'meshes', MAX_GLB_MESHES)
  const primitiveCounts: number[] = []
  const drawElementCounts: number[] = []
  const metadataCloneBytes: number[] = []
  const morphWorkElementCounts: number[] = []
  const morphPrimitiveCounts: number[] = []
  const morphTargetCounts: number[] = []
  const accessorCounters = { elementReferences: 0, references: 0 }
  const materialUseCounts = new Uint16Array(materials.materialCount)
  let totalPrimitives = 0
  let totalMorphTargetReferences = 0
  let morphTextureBytes = 0

  for (const [meshIndex, mesh] of meshes.entries()) {
    const primitives = requiredBoundedArray(
      mesh.primitives,
      `mesh ${meshIndex} primitives`,
      MAX_GLB_PRIMITIVES_PER_MESH
    )
    const metadata = cloneableMetadataByteCounts(mesh, `GLB mesh ${meshIndex}`)
    metadataCloneBytes.push(
      checkedSum(
        checkedProduct(
          metadata.extras,
          primitives.length,
          `GLB mesh ${meshIndex} primitive metadata copies`
        ),
        metadata.extensions,
        `GLB mesh ${meshIndex} loader metadata bytes`
      )
    )
    totalPrimitives = checkedSum(totalPrimitives, primitives.length, 'GLB mesh primitives')
    if (totalPrimitives > MAX_GLB_MESH_PRIMITIVES) {
      throw new Error(`GLB may contain at most ${MAX_GLB_MESH_PRIMITIVES} mesh primitives`)
    }

    let meshMorphTargetCount = -1
    let morphPrimitiveCount = 0
    let meshDrawElements = 0
    let meshMorphWorkElements = 0
    for (const [primitiveIndex, rawPrimitive] of primitives.entries()) {
      if (!isRecord(rawPrimitive)) {
        throw new Error(`GLB mesh ${meshIndex} primitive ${primitiveIndex} is invalid`)
      }
      const name = `GLB mesh ${meshIndex} primitive ${primitiveIndex}`
      const vertexCount = validatePrimitiveAttributes(
        rawPrimitive.attributes,
        accessors,
        name,
        accessorCounters
      )
      let primitiveDrawElements = vertexCount
      if (rawPrimitive.indices !== undefined) {
        const indexAccessor = chargePrimitiveAccessor(
          rawPrimitive.indices,
          accessors,
          `${name} indices`,
          accessorCounters
        )
        if (
          indexAccessor.type !== 'SCALAR' ||
          (indexAccessor.componentType !== 5121 &&
            indexAccessor.componentType !== 5123 &&
            indexAccessor.componentType !== 5125)
        ) {
          throw new Error(`${name} indices must use an unsigned SCALAR accessor`)
        }
        primitiveDrawElements = indexAccessor.count
      }
      meshDrawElements = checkedSum(
        meshDrawElements,
        primitiveDrawElements,
        `GLB mesh ${meshIndex} draw elements`
      )
      if (rawPrimitive.material !== undefined) {
        const materialIndex = referencedIndex(
          rawPrimitive.material,
          materials.materialCount,
          `${name} material`
        )
        materialUseCounts[materialIndex] += 1
      }
      if (rawPrimitive.mode !== undefined) {
        const mode = safeInteger(rawPrimitive.mode, `${name} mode`)
        if (mode > 4) {
          throw new Error(
            `${name} mode ${mode} is outside the bounded loader profile; triangle strips and fans are unsupported`
          )
        }
      }

      const targets = boundedArray(
        rawPrimitive.targets,
        `${name} morph targets`,
        MAX_GLB_MORPH_TARGETS_PER_PRIMITIVE
      )
      if (meshMorphTargetCount === -1) meshMorphTargetCount = targets.length
      if (targets.length !== meshMorphTargetCount) {
        throw new Error(`GLB mesh ${meshIndex} primitives must have equal morph-target counts`)
      }
      if (targets.length > 0) morphPrimitiveCount += 1
      totalMorphTargetReferences = checkedSum(
        totalMorphTargetReferences,
        targets.length,
        'GLB morph-target references'
      )
      if (totalMorphTargetReferences > MAX_GLB_MORPH_TARGET_REFERENCES) {
        throw new Error(
          `GLB primitives exceed ${MAX_GLB_MORPH_TARGET_REFERENCES} aggregate morph-target references`
        )
      }
      for (const [targetIndex, rawTarget] of targets.entries()) {
        if (!isRecord(rawTarget)) throw new Error(`${name} morph target ${targetIndex} is invalid`)
        const targetAttributes = Object.entries(rawTarget)
        if (targetAttributes.length === 0 || targetAttributes.length > 3) {
          throw new Error(`${name} morph target ${targetIndex} must define 1-3 attributes`)
        }
        for (const [semantic, accessorIndex] of targetAttributes) {
          if (semantic !== 'POSITION' && semantic !== 'NORMAL' && semantic !== 'TANGENT') {
            throw new Error(
              `${name} morph target ${targetIndex} semantic ${semantic} is unsupported`
            )
          }
          const accessor = chargePrimitiveAccessor(
            accessorIndex,
            accessors,
            `${name} morph target ${targetIndex} ${semantic}`,
            accessorCounters
          )
          if (accessor.type !== 'VEC3' || accessor.componentType !== 5126) {
            throw new Error(
              `${name} morph target ${targetIndex} ${semantic} must use a FLOAT VEC3 accessor`
            )
          }
          if (accessor.count !== vertexCount) {
            throw new Error(`${name} morph-target accessors must match the vertex count`)
          }
          morphTextureBytes = checkedSum(
            morphTextureBytes,
            checkedProduct(
              accessor.count,
              16,
              `${name} morph target ${targetIndex} ${semantic} texture bytes`
            ),
            'GLB expanded morph texture bytes'
          )
          if (morphTextureBytes > MAX_GLB_MORPH_TEXTURE_BYTES) {
            throw new Error(
              `GLB morph targets exceed ${MAX_GLB_MORPH_TEXTURE_BYTES} expanded texture bytes`
            )
          }
        }
      }
      meshMorphWorkElements = checkedSum(
        meshMorphWorkElements,
        checkedProduct(primitiveDrawElements, targets.length, `${name} morph work elements`),
        `GLB mesh ${meshIndex} morph work elements`
      )
    }

    const finalMorphTargetCount = Math.max(0, meshMorphTargetCount)
    if (mesh.weights !== undefined) {
      if (!Array.isArray(mesh.weights) || mesh.weights.length !== finalMorphTargetCount) {
        throw new Error(`GLB mesh ${meshIndex} weights must match its morph-target count`)
      }
      if (mesh.weights.some((weight) => typeof weight !== 'number' || !Number.isFinite(weight))) {
        throw new Error(`GLB mesh ${meshIndex} weights must contain finite numbers`)
      }
    }
    primitiveCounts.push(primitives.length)
    drawElementCounts.push(meshDrawElements)
    morphWorkElementCounts.push(meshMorphWorkElements)
    morphPrimitiveCounts.push(morphPrimitiveCount)
    morphTargetCounts.push(finalMorphTargetCount)
  }

  let staticMetadataCloneBytes = 0
  for (let materialIndex = 0; materialIndex < materialUseCounts.length; materialIndex += 1) {
    const uses = materialUseCounts[materialIndex]
    if (uses === 0) continue
    // One primitive use can cause the base material, a Points/Line copy, and
    // one geometry-feature variant. Three caches duplicates, so three copies
    // per use is a conservative upper bound over every effective variant.
    const copies = checkedProduct(uses, 3, `GLB material ${materialIndex} copy count`)
    staticMetadataCloneBytes = checkedSum(
      staticMetadataCloneBytes,
      checkedProduct(
        materials.materialMetadataBytes[materialIndex],
        copies,
        `GLB material ${materialIndex} cloned metadata bytes`
      ),
      'GLB material cloned metadata bytes'
    )
    if (staticMetadataCloneBytes > MAX_GLB_METADATA_CLONE_BYTES) {
      throw new Error(
        `GLB cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
      )
    }
  }

  return {
    drawElementCounts,
    metadataCloneBytes,
    morphWorkElementCounts,
    morphPrimitiveCounts,
    morphTargetCounts,
    primitiveCounts,
    staticMetadataCloneBytes,
    morphTextureBytes,
    totalPrimitives,
  }
}

interface ValidatedNodeGraph {
  children: number[][]
  morphPrimitiveCounts: number[]
  morphTargetCounts: number[]
  nodes: JsonRecord[]
  parents: Int32Array
  instantiatedDrawElements: number
  instantiatedMorphWork: number
  directMetadataBytes: number[]
  primitiveInstances: number
  staticMetadataCloneBytes: number
  subtreeSizes: number[]
}

function mergeMorphTargetCount(current: number, incoming: number): number {
  if (current === -1 || incoming === -1) return -1
  if (incoming === 0) return current
  if (current === 0 || current === incoming) return incoming
  return -1
}

function validateSkinStructure(
  manifest: JsonRecord,
  nodes: JsonRecord[],
  accessors: ValidatedAccessor[]
): JsonRecord[] {
  const skins = boundedRecordArray(manifest.skins, 'skins', MAX_GLB_SKINS)
  let jointReferences = 0
  for (const [skinIndex, skin] of skins.entries()) {
    const joints = requiredBoundedArray(
      skin.joints,
      `skin ${skinIndex} joints`,
      MAX_GLB_JOINTS_PER_SKIN
    )
    jointReferences = checkedSum(jointReferences, joints.length, 'GLB skin joint references')
    if (jointReferences > MAX_GLB_SKIN_JOINT_REFERENCES) {
      throw new Error(
        `GLB skins exceed ${MAX_GLB_SKIN_JOINT_REFERENCES} aggregate joint references`
      )
    }
    const uniqueJoints = new Set<number>()
    for (const [jointIndex, rawJoint] of joints.entries()) {
      const nodeIndex = referencedIndex(
        rawJoint,
        nodes.length,
        `GLB skin ${skinIndex} joint ${jointIndex}`
      )
      if (uniqueJoints.has(nodeIndex)) throw new Error(`GLB skin ${skinIndex} repeats a joint`)
      uniqueJoints.add(nodeIndex)
    }
    if (skin.skeleton !== undefined) {
      referencedIndex(skin.skeleton, nodes.length, `GLB skin ${skinIndex} skeleton`)
    }
    if (skin.inverseBindMatrices !== undefined) {
      const accessorIndex = referencedIndex(
        skin.inverseBindMatrices,
        accessors.length,
        `GLB skin ${skinIndex} inverseBindMatrices`
      )
      const accessor = accessors[accessorIndex]
      if (
        accessor.type !== 'MAT4' ||
        accessor.componentType !== 5126 ||
        accessor.count !== joints.length
      ) {
        throw new Error(
          `GLB skin ${skinIndex} inverseBindMatrices must be one FLOAT MAT4 per joint`
        )
      }
    }
  }
  return skins
}

function validateNodeGraph(
  manifest: JsonRecord,
  meshStructure: ValidatedMeshStructure,
  accessors: ValidatedAccessor[]
): ValidatedNodeGraph {
  const nodes = boundedRecordArray(manifest.nodes, 'nodes', MAX_GLB_NODES)
  const cameras = boundedRecordArray(manifest.cameras, 'cameras', MAX_GLB_CAMERAS)
  const cameraMetadataBytes = cameras.map((camera, cameraIndex) =>
    cloneableMetadataBytes(camera, `GLB camera ${cameraIndex}`)
  )
  const skins = validateSkinStructure(manifest, nodes, accessors)
  const children: number[][] = Array.from({ length: nodes.length }, () => [])
  const parents = new Int32Array(nodes.length)
  parents.fill(-1)
  let primitiveInstances = 0
  let instantiatedDrawElements = 0
  let instantiatedMorphWork = 0
  let staticMetadataCloneBytes = meshStructure.staticMetadataCloneBytes
  const meshReferenceCounts = new Uint16Array(meshStructure.primitiveCounts.length)
  const cameraReferenceCounts = new Uint16Array(cameras.length)
  const directMetadataBytes = nodes.map((node, nodeIndex) =>
    cloneableMetadataBytes(node, `GLB node ${nodeIndex}`)
  )
  const directMorphPrimitiveCounts = new Array<number>(nodes.length).fill(0)
  const directMorphTargetCounts = new Array<number>(nodes.length).fill(0)

  for (const [nodeIndex, node] of nodes.entries()) {
    let meshIndex: number | undefined
    if (node.mesh !== undefined) {
      meshIndex = referencedIndex(
        node.mesh,
        meshStructure.primitiveCounts.length,
        `GLB node ${nodeIndex} mesh`
      )
      primitiveInstances = checkedSum(
        primitiveInstances,
        meshStructure.primitiveCounts[meshIndex],
        'GLB primitive instances'
      )
      if (primitiveInstances > MAX_GLB_PRIMITIVE_INSTANCES) {
        throw new Error(
          `GLB nodes exceed ${MAX_GLB_PRIMITIVE_INSTANCES} aggregate primitive instances`
        )
      }
      meshReferenceCounts[meshIndex] += 1
      instantiatedDrawElements = checkedSum(
        instantiatedDrawElements,
        meshStructure.drawElementCounts[meshIndex],
        'GLB instantiated draw elements'
      )
      if (instantiatedDrawElements > MAX_GLB_INSTANTIATED_DRAW_ELEMENTS) {
        throw new Error(
          `GLB nodes exceed ${MAX_GLB_INSTANTIATED_DRAW_ELEMENTS} aggregate instantiated draw elements`
        )
      }
      instantiatedMorphWork = checkedSum(
        instantiatedMorphWork,
        meshStructure.morphWorkElementCounts[meshIndex],
        'GLB instantiated morph work'
      )
      if (instantiatedMorphWork > MAX_GLB_INSTANTIATED_MORPH_WORK) {
        throw new Error(
          `GLB nodes exceed ${MAX_GLB_INSTANTIATED_MORPH_WORK} aggregate instantiated morph work elements`
        )
      }
      directMetadataBytes[nodeIndex] = checkedSum(
        directMetadataBytes[nodeIndex],
        meshStructure.metadataCloneBytes[meshIndex],
        `GLB node ${nodeIndex} attached metadata bytes`
      )
      directMorphPrimitiveCounts[nodeIndex] = meshStructure.morphPrimitiveCounts[meshIndex]
      directMorphTargetCounts[nodeIndex] = meshStructure.morphTargetCounts[meshIndex]
    }
    if (node.camera !== undefined) {
      const cameraIndex = referencedIndex(
        node.camera,
        cameras.length,
        `GLB node ${nodeIndex} camera`
      )
      cameraReferenceCounts[cameraIndex] += 1
      directMetadataBytes[nodeIndex] = checkedSum(
        directMetadataBytes[nodeIndex],
        cameraMetadataBytes[cameraIndex],
        `GLB node ${nodeIndex} attached metadata bytes`
      )
    }
    if (node.skin !== undefined) {
      referencedIndex(node.skin, skins.length, `GLB node ${nodeIndex} skin`)
      if (meshIndex === undefined) throw new Error(`GLB node ${nodeIndex} skin requires a mesh`)
    }
    if (node.weights !== undefined) {
      if (
        meshIndex === undefined ||
        !Array.isArray(node.weights) ||
        node.weights.length !== meshStructure.morphTargetCounts[meshIndex] ||
        node.weights.some((weight) => typeof weight !== 'number' || !Number.isFinite(weight))
      ) {
        throw new Error(`GLB node ${nodeIndex} weights must match its mesh morph-target count`)
      }
    }

    const rawChildren = boundedArray(node.children, `node ${nodeIndex} children`, MAX_GLB_NODES)
    const uniqueChildren = new Set<number>()
    for (const [childOffset, rawChild] of rawChildren.entries()) {
      const childIndex = referencedIndex(
        rawChild,
        nodes.length,
        `GLB node ${nodeIndex} child ${childOffset}`
      )
      if (uniqueChildren.has(childIndex)) throw new Error(`GLB node ${nodeIndex} repeats a child`)
      if (parents[childIndex] !== -1) {
        throw new Error(`GLB node ${childIndex} has multiple parents`)
      }
      uniqueChildren.add(childIndex)
      parents[childIndex] = nodeIndex
      children[nodeIndex].push(childIndex)
    }
  }

  for (let meshIndex = 0; meshIndex < meshReferenceCounts.length; meshIndex += 1) {
    if (meshReferenceCounts[meshIndex] <= 1) continue
    staticMetadataCloneBytes = checkedSum(
      staticMetadataCloneBytes,
      meshStructure.metadataCloneBytes[meshIndex],
      'GLB base mesh metadata bytes'
    )
  }
  for (let cameraIndex = 0; cameraIndex < cameraReferenceCounts.length; cameraIndex += 1) {
    if (cameraReferenceCounts[cameraIndex] === 1) continue
    staticMetadataCloneBytes = checkedSum(
      staticMetadataCloneBytes,
      cameraMetadataBytes[cameraIndex],
      'GLB base camera metadata bytes'
    )
  }
  if (staticMetadataCloneBytes > MAX_GLB_METADATA_CLONE_BYTES) {
    throw new Error(
      `GLB cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
    )
  }

  const pendingChildren = children.map((nodeChildren) => nodeChildren.length)
  const order: number[] = []
  const leaves: number[] = []
  for (let nodeIndex = 0; nodeIndex < pendingChildren.length; nodeIndex += 1) {
    if (pendingChildren[nodeIndex] === 0) leaves.push(nodeIndex)
  }
  while (leaves.length > 0) {
    const nodeIndex = leaves.pop() as number
    order.push(nodeIndex)
    const parentIndex = parents[nodeIndex]
    if (parentIndex !== -1) {
      pendingChildren[parentIndex] -= 1
      if (pendingChildren[parentIndex] === 0) leaves.push(parentIndex)
    }
  }
  if (order.length !== nodes.length) throw new Error('GLB node hierarchy contains a cycle')

  const subtreeSizes = new Array<number>(nodes.length).fill(1)
  const subtreeDepths = new Array<number>(nodes.length).fill(1)
  const morphPrimitiveCounts = [...directMorphPrimitiveCounts]
  const morphTargetCounts = [...directMorphTargetCounts]
  for (const nodeIndex of order) {
    const parentIndex = parents[nodeIndex]
    if (parentIndex === -1) continue
    subtreeSizes[parentIndex] = checkedSum(
      subtreeSizes[parentIndex],
      subtreeSizes[nodeIndex],
      'GLB node subtree size'
    )
    subtreeDepths[parentIndex] = Math.max(subtreeDepths[parentIndex], subtreeDepths[nodeIndex] + 1)
    if (subtreeDepths[parentIndex] > MAX_GLB_NODE_HIERARCHY_DEPTH) {
      throw new Error(
        `GLB node hierarchy exceeds the maximum depth of ${MAX_GLB_NODE_HIERARCHY_DEPTH}`
      )
    }
    morphPrimitiveCounts[parentIndex] = checkedSum(
      morphPrimitiveCounts[parentIndex],
      morphPrimitiveCounts[nodeIndex],
      'GLB subtree morph primitive count'
    )
    morphTargetCounts[parentIndex] = mergeMorphTargetCount(
      morphTargetCounts[parentIndex],
      morphTargetCounts[nodeIndex]
    )
  }

  return {
    children,
    morphPrimitiveCounts,
    morphTargetCounts,
    nodes,
    parents,
    instantiatedDrawElements,
    instantiatedMorphWork,
    directMetadataBytes,
    primitiveInstances,
    staticMetadataCloneBytes,
    subtreeSizes,
  }
}

function validateScenes(
  manifest: JsonRecord,
  graph: ValidatedNodeGraph
): { graphVisits: number; metadataCloneBytes: number } {
  const scenes = boundedRecordArray(manifest.scenes, 'scenes', MAX_GLB_SCENES)
  if (manifest.scene !== undefined) {
    referencedIndex(manifest.scene, scenes.length, 'GLB default scene')
  }

  let rootReferences = 0
  let graphVisits = 0
  let metadataCloneBytes = graph.staticMetadataCloneBytes
  const metadataVisits = new Uint16Array(graph.nodes.length)
  const chargeMetadata = (nodeIndex: number): void => {
    metadataCloneBytes = checkedSum(
      metadataCloneBytes,
      graph.directMetadataBytes[nodeIndex],
      'GLB scene metadata clone bytes'
    )
    if (metadataCloneBytes > MAX_GLB_METADATA_CLONE_BYTES) {
      throw new Error(
        `GLB cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
      )
    }
    metadataVisits[nodeIndex] += 1
  }
  for (const [sceneIndex, scene] of scenes.entries()) {
    const roots = boundedArray(
      scene.nodes,
      `scene ${sceneIndex} root nodes`,
      MAX_GLB_SCENE_ROOTS_PER_SCENE
    )
    rootReferences = checkedSum(rootReferences, roots.length, 'GLB scene root references')
    if (rootReferences > MAX_GLB_SCENE_ROOT_REFERENCES) {
      throw new Error(
        `GLB scenes exceed ${MAX_GLB_SCENE_ROOT_REFERENCES} aggregate root-node references`
      )
    }
    const uniqueRoots = new Set<number>()
    for (const [rootOffset, rawRoot] of roots.entries()) {
      const rootIndex = referencedIndex(
        rawRoot,
        graph.nodes.length,
        `GLB scene ${sceneIndex} root ${rootOffset}`
      )
      if (uniqueRoots.has(rootIndex)) throw new Error(`GLB scene ${sceneIndex} repeats a root node`)
      if (graph.parents[rootIndex] !== -1) {
        throw new Error(`GLB scene ${sceneIndex} references node ${rootIndex}, which is not a root`)
      }
      uniqueRoots.add(rootIndex)
      graphVisits = checkedSum(graphVisits, graph.subtreeSizes[rootIndex], 'GLB scene graph visits')
      if (graphVisits > MAX_GLB_GRAPH_VISITS) {
        throw new Error(`GLB scenes exceed ${MAX_GLB_GRAPH_VISITS} aggregate graph visits`)
      }
      const pendingNodes = [rootIndex]
      while (pendingNodes.length > 0) {
        const nodeIndex = pendingNodes.pop() as number
        chargeMetadata(nodeIndex)
        pendingNodes.push(...graph.children[nodeIndex])
      }
    }
  }
  for (let nodeIndex = 0; nodeIndex < metadataVisits.length; nodeIndex += 1) {
    if (metadataVisits[nodeIndex] === 0) chargeMetadata(nodeIndex)
  }
  return { graphVisits, metadataCloneBytes }
}

function validateGlbStructure(
  manifest: JsonRecord,
  accessors: ValidatedAccessor[]
): GlbStructureSummary {
  const materialTextures = validateMaterialAndTextureStructure(manifest)
  const meshStructure = validateMeshStructure(manifest, accessors, materialTextures)
  const graph = validateNodeGraph(manifest, meshStructure, accessors)
  const scenes = validateScenes(manifest, graph)
  const animations = validateAnimations(manifest, accessors, graph)
  return {
    animationChannels: animations.channels,
    animationKeyframes: animations.keyframes,
    animationTracks: animations.tracks,
    animationWorkComponents: animations.workComponents,
    graphVisits: scenes.graphVisits,
    meshPrimitives: meshStructure.totalPrimitives,
    nodes: graph.nodes.length,
    primitiveInstances: graph.primitiveInstances,
    instantiatedDrawElements: graph.instantiatedDrawElements,
    instantiatedMorphWork: graph.instantiatedMorphWork,
    morphTextureBytes: meshStructure.morphTextureBytes,
    metadataCloneBytes: scenes.metadataCloneBytes,
    textureVariantCounts: materialTextures.textureVariantCounts,
  }
}

/**
 * Validate a bounded, self-contained GLB profile with one canonical JSON chunk.
 * The single-manifest rule ensures downstream GLTFLoader parsing cannot select
 * a different manifest after this function approves the container.
 */
export function validateSelfContainedGlb(
  buffer: ArrayBuffer,
  maxTexturePixels: number = MAX_GLB_TEXTURE_PIXELS
): GlbValidationSummary {
  if (buffer.byteLength < 20) throw new Error('GLB is too short')
  if (!Number.isSafeInteger(maxTexturePixels) || maxTexturePixels <= 0) {
    throw new Error('GLB texture pixel limit must be a positive safe integer')
  }
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
    throw new Error('Asset is not a GLB 2.0 container')
  }
  if (view.getUint32(8, true) !== buffer.byteLength) {
    throw new Error('GLB declared length does not match the downloaded bytes')
  }
  if (buffer.byteLength % 4 !== 0) throw new Error('GLB container length must be 4-byte aligned')

  let offset = 12
  let chunkIndex = 0
  let jsonBytes: Uint8Array | null = null
  let binBytes: Uint8Array | null = null
  while (offset < buffer.byteLength) {
    if (offset % 4 !== 0) throw new Error('GLB chunk header is not 4-byte aligned')
    if (offset + 8 > buffer.byteLength) throw new Error('GLB chunk header is truncated')
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + length
    if (length % 4 !== 0) throw new Error('GLB chunk length must be 4-byte aligned')
    if (!Number.isSafeInteger(end) || end > buffer.byteLength || end < start) {
      throw new Error('GLB chunk exceeds its container')
    }
    if (chunkIndex === 0 && type !== JSON_CHUNK_TYPE) {
      throw new Error('GLB JSON chunk must be the first chunk')
    }
    if (type === JSON_CHUNK_TYPE) {
      if (chunkIndex !== 0 || jsonBytes) {
        throw new Error('GLB must contain exactly one JSON chunk, first in the container')
      }
      if (length > MAX_GLB_JSON_BYTES) {
        throw new Error(`GLB JSON chunk exceeds ${MAX_GLB_JSON_BYTES} bytes`)
      }
      jsonBytes = new Uint8Array(buffer, start, length)
    } else if (type === BIN_CHUNK_TYPE) {
      if (chunkIndex !== 1 || binBytes) {
        throw new Error('GLB may contain one BIN chunk immediately after its JSON chunk')
      }
      binBytes = new Uint8Array(buffer, start, length)
    } else {
      throw new Error('GLB contains an unsupported chunk type')
    }
    offset = end
    chunkIndex += 1
  }
  if (!jsonBytes) throw new Error('GLB has no JSON chunk')

  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
  } catch {
    throw new Error('GLB JSON chunk is invalid UTF-8 or JSON')
  }
  validateGlbJsonSyntax(json)

  let manifest: unknown
  try {
    manifest = JSON.parse(json)
  } catch {
    throw new Error('GLB JSON chunk is invalid UTF-8 or JSON')
  }
  if (!isRecord(manifest)) throw new Error('GLB manifest must be an object')
  rejectExternalUris(manifest)
  rejectUnsupportedLoaderAmplification(manifest)

  const validatedBufferViews = validateBuffersAndViews(manifest, binBytes)
  const validatedAccessors = validateAccessors(manifest, validatedBufferViews, binBytes)
  const { textureVariantCounts, ...structure } = validateGlbStructure(
    manifest,
    validatedAccessors.accessors
  )

  const images = manifest.images
  if (images === undefined) {
    return {
      ...structure,
      decodedAccessorBytes: validatedAccessors.decodedBytes,
      decodedTexturePixels: 0,
      residentTexturePixels: 0,
      referencedImages: 0,
      inspectedImageSpans: 0,
    }
  }
  if (!Array.isArray(images) || images.length > MAX_EMBEDDED_IMAGES) {
    throw new Error(`GLB may contain at most ${MAX_EMBEDDED_IMAGES} embedded images`)
  }
  let totalPixels = 0
  let residentPixels = 0
  let metadataCloneBytes = structure.metadataCloneBytes
  const inspectedSpans = new Map<string, EncodedImageInspection>()
  const inspectedBinSpans: Array<readonly [start: number, end: number]> = []
  for (const [imageIndex, rawImage] of images.entries()) {
    if (!isRecord(rawImage)) throw new Error(`GLB image ${imageIndex} is invalid`)
    const textureIdentityCount = Math.max(1, textureVariantCounts[imageIndex] ?? 0)
    metadataCloneBytes = checkedSum(
      metadataCloneBytes,
      checkedProduct(
        cloneableMetadataBytes(rawImage, `GLB image ${imageIndex}`),
        textureIdentityCount,
        `GLB image ${imageIndex} cloned metadata bytes`
      ),
      'GLB cloned image metadata bytes'
    )
    if (metadataCloneBytes > MAX_GLB_METADATA_CLONE_BYTES) {
      throw new Error(
        `GLB cloneable metadata exceeds ${MAX_GLB_METADATA_CLONE_BYTES} aggregate expanded bytes`
      )
    }
    let imageBytes: Uint8Array
    let spanKey: string
    let binSpan: readonly [start: number, end: number] | undefined
    let declaredMimeType = rawImage.mimeType
    if (typeof rawImage.uri === 'string') {
      if (rawImage.bufferView !== undefined) {
        throw new Error(`GLB image ${imageIndex} cannot define both uri and bufferView`)
      }
      const decoded = decodeImageDataUri(rawImage.uri)
      imageBytes = decoded.bytes
      declaredMimeType ??= decoded.mimeType
      const cacheKey = `uri:${rawImage.uri}`
      const cachedInspection = inspectedSpans.get(cacheKey)
      const inspection = cachedInspection ?? inspectEncodedImage(imageBytes)
      if (!cachedInspection) inspectedSpans.set(cacheKey, inspection)
      validateDeclaredImageMimeType(inspection.mimeType, declaredMimeType)
      const dimensions = inspection.dimensions
      const [width, height] = dimensions
      if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        throw new Error(`GLB embedded image dimensions must be within 1-${MAX_IMAGE_DIMENSION}`)
      }
      const pixels = checkedProduct(width, height, `GLB image ${imageIndex} pixels`)
      if (totalPixels + pixels > maxTexturePixels) {
        throw new Error(`GLB embedded textures exceed ${maxTexturePixels} aggregate pixels`)
      }
      totalPixels += pixels
      const residentImagePixels = checkedProduct(
        pixels,
        textureIdentityCount,
        `GLB image ${imageIndex} resident texture pixels`
      )
      residentPixels = checkedSum(
        residentPixels,
        residentImagePixels,
        'GLB resident texture pixels'
      )
      if (residentPixels > maxTexturePixels) {
        throw new Error(`GLB resident texture variants exceed ${maxTexturePixels} aggregate pixels`)
      }
      continue
    } else {
      if (typeof declaredMimeType !== 'string') {
        throw new Error(`GLB image ${imageIndex} bufferView requires a MIME type`)
      }
      const bufferViewIndex = safeInteger(rawImage.bufferView, `GLB image ${imageIndex} bufferView`)
      const bufferView = validatedBufferViews[bufferViewIndex]
      if (!bufferView || !binBytes) {
        throw new Error(`GLB image ${imageIndex} does not reference an embedded buffer view`)
      }
      if (bufferView.byteStride !== undefined) {
        throw new Error(`GLB image ${imageIndex} requires a packed bufferView`)
      }
      const end = checkedSum(
        bufferView.byteOffset,
        bufferView.byteLength,
        `GLB image ${imageIndex} bufferView`
      )
      imageBytes = binBytes.subarray(bufferView.byteOffset, end)
      spanKey = `bin:${bufferView.byteOffset}:${bufferView.byteLength}`
      binSpan = [bufferView.byteOffset, end]
    }
    const cachedInspection = inspectedSpans.get(spanKey)
    if (!cachedInspection && binSpan) {
      for (const [inspectedStart, inspectedEnd] of inspectedBinSpans) {
        if (binSpan[0] < inspectedEnd && inspectedStart < binSpan[1]) {
          throw new Error(
            'GLB embedded image bufferViews may be exact aliases but cannot otherwise overlap'
          )
        }
      }
      inspectedBinSpans.push(binSpan)
    }
    const inspection = cachedInspection ?? inspectEncodedImage(imageBytes)
    if (!cachedInspection) inspectedSpans.set(spanKey, inspection)
    validateDeclaredImageMimeType(inspection.mimeType, declaredMimeType)
    const dimensions = inspection.dimensions
    const [width, height] = dimensions
    if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      throw new Error(`GLB embedded image dimensions must be within 1-${MAX_IMAGE_DIMENSION}`)
    }
    const pixels = checkedProduct(width, height, `GLB image ${imageIndex} pixels`)
    if (totalPixels + pixels > maxTexturePixels) {
      throw new Error(`GLB embedded textures exceed ${maxTexturePixels} aggregate pixels`)
    }
    totalPixels += pixels
    const residentImagePixels = checkedProduct(
      pixels,
      textureIdentityCount,
      `GLB image ${imageIndex} resident texture pixels`
    )
    residentPixels = checkedSum(residentPixels, residentImagePixels, 'GLB resident texture pixels')
    if (residentPixels > maxTexturePixels) {
      throw new Error(`GLB resident texture variants exceed ${maxTexturePixels} aggregate pixels`)
    }
  }
  return {
    ...structure,
    decodedAccessorBytes: validatedAccessors.decodedBytes,
    decodedTexturePixels: totalPixels,
    residentTexturePixels: residentPixels,
    referencedImages: images.length,
    inspectedImageSpans: inspectedSpans.size,
    metadataCloneBytes,
  }
}
