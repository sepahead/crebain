import type * as THREE from 'three'

type UnknownRecord = Record<string, unknown>

interface CloseableImageData {
  close(): void
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isRecord(value: unknown): value is UnknownRecord {
  return isObject(value)
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isObject(value)) {
    return false
  }

  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isTexture(value: unknown): value is THREE.Texture {
  return isRecord(value) && value.isTexture === true && typeof value.dispose === 'function'
}

function isCloseableImageData(value: object): value is object & CloseableImageData {
  return 'close' in value && typeof value.close === 'function'
}

function attemptCleanup(errors: unknown[], operation: () => void): void {
  try {
    operation()
  } catch (error) {
    errors.push(error)
  }
}

function closeImageData(value: unknown, visited: Set<object>, errors: unknown[]): void {
  const pending: unknown[] = [value]

  while (pending.length > 0) {
    const candidate = pending.pop()
    if (!isObject(candidate) || visited.has(candidate)) {
      continue
    }
    visited.add(candidate)

    if (Array.isArray(candidate)) {
      const items = candidate as unknown[]
      pending.push(...items)
    } else if (isCloseableImageData(candidate)) {
      attemptCleanup(errors, () => candidate.close())
    }
  }
}

function disposeTexture(
  texture: THREE.Texture,
  disposedTextures: Set<THREE.Texture>,
  closedImageData: Set<object>,
  errors: unknown[]
): void {
  if (disposedTextures.has(texture)) {
    return
  }
  disposedTextures.add(texture)

  closeImageData(texture.image, closedImageData, errors)
  closeImageData(texture.source.data, closedImageData, errors)
  attemptCleanup(errors, () => texture.dispose())
}

/**
 * Find texture references in a known material value container. Material fields
 * are scanned shallowly (plus arrays); shader uniform values additionally allow
 * plain-object structs. This avoids following arbitrary class instances and
 * their potentially cyclic object graphs.
 */
function disposeTextureReferences(
  initialValue: unknown,
  includePlainRecords: boolean,
  disposedTextures: Set<THREE.Texture>,
  closedImageData: Set<object>,
  errors: unknown[]
): void {
  const pending: unknown[] = [initialValue]
  const visitedContainers = new Set<object>()

  while (pending.length > 0) {
    const value = pending.pop()
    if (isTexture(value)) {
      disposeTexture(value, disposedTextures, closedImageData, errors)
      continue
    }
    if (!isObject(value) || visitedContainers.has(value)) {
      continue
    }

    if (Array.isArray(value)) {
      visitedContainers.add(value)
      const items = value as unknown[]
      pending.push(...items)
    } else if (includePlainRecords && isPlainRecord(value)) {
      visitedContainers.add(value)
      pending.push(...Object.values(value))
    }
  }
}

function disposeMaterialTextures(
  material: THREE.Material,
  disposedTextures: Set<THREE.Texture>,
  closedImageData: Set<object>,
  errors: unknown[]
): void {
  const properties = material as unknown as UnknownRecord

  for (const [name, value] of Object.entries(properties)) {
    if (name !== 'uniforms') {
      disposeTextureReferences(value, false, disposedTextures, closedImageData, errors)
    }
  }

  const uniforms = properties.uniforms
  if (!isRecord(uniforms)) {
    return
  }

  for (const uniform of Object.values(uniforms)) {
    if (isRecord(uniform) && 'value' in uniform) {
      disposeTextureReferences(uniform.value, true, disposedTextures, closedImageData, errors)
    }
  }
}

/**
 * Type guard for {@link THREE.Mesh}.
 *
 * `node instanceof THREE.Mesh` narrows to `Mesh<any, any, any>` in TypeScript,
 * which silently leaks `any` through `.geometry` and `.material`. Narrowing via
 * the runtime `isMesh` flag yields a concrete `THREE.Mesh` whose members stay
 * fully typed.
 */
export function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh
}

/**
 * Invoke `callback` for every {@link THREE.Mesh} in the subtree rooted at `root`
 * (inclusive), with the mesh narrowed to a concrete, type-safe `THREE.Mesh`.
 */
export function forEachMesh(root: THREE.Object3D, callback: (mesh: THREE.Mesh) => void): void {
  root.traverse((node) => {
    if (isMesh(node)) {
      callback(node)
    }
  })
}

/**
 * Resolve a human-readable label for a scene object: its `name`, falling back to
 * a string `userData.id`, then to `fallback`. Centralizes the safe read of the
 * untyped `userData` bag so callers stay type-safe.
 */
export function objectLabel(object: THREE.Object3D, fallback = 'OBJEKT'): string {
  if (object.name) {
    return object.name
  }
  const id: unknown = object.userData.id
  return typeof id === 'string' ? id : fallback
}

/**
 * Resolve a stable identifier for a scene object: a string `userData.id`, then a
 * string `userData.assetId`, then the object's intrinsic `uuid`. Centralizes the
 * safe read of the untyped `userData` bag so callers stay type-safe.
 */
export function objectId(object: THREE.Object3D): string {
  const id: unknown = object.userData.id
  if (typeof id === 'string') {
    return id
  }
  const assetId: unknown = object.userData.assetId
  if (typeof assetId === 'string') {
    return assetId
  }
  return object.uuid
}

export interface Object3DAttachmentResult {
  /** True only when the object is reachable from the requested live scene. */
  attached: boolean
  /** Synchronous scene-event failures observed while ownership was transferred. */
  errors: unknown[]
}

/**
 * Test whether an object is reachable from one exact scene.
 *
 * Three.js updates `parent` before it dispatches `added` and `removed` events.
 * An event listener can therefore throw even though the graph mutation took
 * effect. Ownership code must inspect the graph instead of inferring state from
 * whether `Scene.add` returned normally.
 */
export function isObject3DInScene(scene: THREE.Scene | null, object: THREE.Object3D): boolean {
  if (!scene) return false
  let current: THREE.Object3D | null = object
  while (current) {
    if (current === scene) return true
    current = current.parent
  }
  return false
}

/**
 * Attach a retained object and report ownership from the resulting graph.
 * A listener failure is preserved as an error, but it does not make an object
 * that reached the scene safe for a detached-resource disposer.
 */
export function attachObject3DToScene(
  scene: THREE.Scene | null,
  object: THREE.Object3D,
  label: string
): Object3DAttachmentResult {
  const errors: unknown[] = []
  if (!scene) {
    errors.push(new Error(`Cannot restore ${label}: scene is unavailable`))
    return { attached: false, errors }
  }

  try {
    scene.add(object)
  } catch (error) {
    errors.push(error)
  }

  const attached = isObject3DInScene(scene, object)
  if (!attached && errors.length === 0) {
    errors.push(new Error(`Cannot restore ${label}: object did not attach to the live scene`))
  }
  return { attached, errors }
}

/**
 * Recursively dispose the GPU resources (geometries, textures, and materials) of
 * every mesh in the subtree rooted at `root`.
 *
 * three.js does not release these resources automatically when an object is
 * removed from a scene, so callers must dispose meshes explicitly to avoid GPU
 * memory leaks. The root must already be detached. Disposing an attached root
 * can invalidate resources that a live scene graph still renders.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  if (root.parent !== null) {
    throw new Error(`Cannot dispose attached Three.js object: ${objectLabel(root)}`)
  }

  const disposedGeometries = new Set<THREE.BufferGeometry>()
  const disposedMaterials = new Set<THREE.Material>()
  const disposedTextures = new Set<THREE.Texture>()
  const closedImageData = new Set<object>()
  const errors: unknown[] = []

  forEachMesh(root, (mesh) => {
    if (!disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry)
      attemptCleanup(errors, () => mesh.geometry.dispose())
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (disposedMaterials.has(material)) {
        continue
      }
      disposedMaterials.add(material)
      disposeMaterialTextures(material, disposedTextures, closedImageData, errors)
      attemptCleanup(errors, () => material.dispose())
    }
  })

  if (errors.length > 0) {
    throw new AggregateError(errors, 'One or more Three.js resources failed to dispose')
  }
}
