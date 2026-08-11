import {
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  ShaderMaterial,
  Texture,
} from 'three'
import { describe, expect, it, vi } from 'vitest'
import { attachObject3DToScene, disposeObject3D, isObject3DInScene } from '../sceneObjects'

describe('disposeObject3D', () => {
  it('rejects an attached root before disposing any resource', () => {
    const geometry = new BufferGeometry()
    const material = new MeshBasicMaterial()
    const root = new Group()
    const parent = new Group()
    root.add(new Mesh(geometry, material))
    parent.add(root)

    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')

    expect(() => disposeObject3D(root)).toThrow('Cannot dispose attached Three.js object')
    expect(root.parent).toBe(parent)
    expect(geometryDispose).not.toHaveBeenCalled()
    expect(materialDispose).not.toHaveBeenCalled()
  })

  it('disposes shared geometry, materials, textures, and image data exactly once', () => {
    const imageData = { close: vi.fn() }
    const sharedTexture = new Texture(imageData)
    const uniformTexture = new Texture(imageData)
    const geometry = new BufferGeometry()
    const standardMaterial = new MeshBasicMaterial({ map: sharedTexture })
    const shaderMaterial = new ShaderMaterial({
      uniforms: {
        shared: { value: sharedTexture },
        nested: { value: [{ layers: { color: uniformTexture } }] },
      },
    })
    const root = new Group()

    root.add(
      new Mesh(geometry, standardMaterial),
      new Mesh(geometry, [standardMaterial, shaderMaterial])
    )

    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const standardMaterialDispose = vi.spyOn(standardMaterial, 'dispose')
    const shaderMaterialDispose = vi.spyOn(shaderMaterial, 'dispose')
    const sharedTextureDispose = vi.spyOn(sharedTexture, 'dispose')
    const uniformTextureDispose = vi.spyOn(uniformTexture, 'dispose')

    disposeObject3D(root)

    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(standardMaterialDispose).toHaveBeenCalledOnce()
    expect(shaderMaterialDispose).toHaveBeenCalledOnce()
    expect(sharedTextureDispose).toHaveBeenCalledOnce()
    expect(uniformTextureDispose).toHaveBeenCalledOnce()
    expect(imageData.close).toHaveBeenCalledOnce()
  })

  it('continues disposing independent resources after cleanup failures', () => {
    const failingImage = {
      close: vi.fn(() => {
        throw new Error('image close failed')
      }),
    }
    const failingTexture = new Texture(failingImage)
    const firstGeometry = new BufferGeometry()
    const secondGeometry = new BufferGeometry()
    const firstMaterial = new MeshBasicMaterial({ map: failingTexture })
    const secondMaterial = new MeshBasicMaterial()
    const root = new Group()
    root.add(new Mesh(firstGeometry, firstMaterial), new Mesh(secondGeometry, secondMaterial))

    const firstGeometryDispose = vi.spyOn(firstGeometry, 'dispose').mockImplementation(() => {
      throw new Error('geometry dispose failed')
    })
    const secondGeometryDispose = vi.spyOn(secondGeometry, 'dispose')
    const textureDispose = vi.spyOn(failingTexture, 'dispose')
    const firstMaterialDispose = vi.spyOn(firstMaterial, 'dispose').mockImplementation(() => {
      throw new Error('material dispose failed')
    })
    const secondMaterialDispose = vi.spyOn(secondMaterial, 'dispose')

    let thrown: unknown
    try {
      disposeObject3D(root)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(3)
    expect(firstGeometryDispose).toHaveBeenCalledOnce()
    expect(secondGeometryDispose).toHaveBeenCalledOnce()
    expect(failingImage.close).toHaveBeenCalledOnce()
    expect(textureDispose).toHaveBeenCalledOnce()
    expect(firstMaterialDispose).toHaveBeenCalledOnce()
    expect(secondMaterialDispose).toHaveBeenCalledOnce()
  })
})

describe('scene object attachment ownership', () => {
  it('recognizes descendants and rejects objects owned by another scene', () => {
    const scene = new Scene()
    const nested = new Group()
    const child = new Group()
    const otherScene = new Scene()
    scene.add(nested)
    nested.add(child)

    expect(isObject3DInScene(scene, scene)).toBe(true)
    expect(isObject3DInScene(scene, child)).toBe(true)
    expect(isObject3DInScene(otherScene, child)).toBe(false)
    expect(isObject3DInScene(null, child)).toBe(false)
  })

  it('reports listener errors without surrendering ownership of an attached object', () => {
    const scene = new Scene()
    const object = new Group()
    object.addEventListener('added', () => {
      throw new Error('listener failed after attachment')
    })

    const result = attachObject3DToScene(scene, object, 'retained asset')

    expect(result.attached).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(object.parent).toBe(scene)
  })

  it('retains detached ownership when no live scene is available', () => {
    const object = new Group()

    const result = attachObject3DToScene(null, object, 'retained asset')

    expect(result.attached).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(object.parent).toBeNull()
  })
})
