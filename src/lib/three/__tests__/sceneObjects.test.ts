import { BufferGeometry, Group, Mesh, MeshBasicMaterial, ShaderMaterial, Texture } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { disposeObject3D } from '../sceneObjects'

describe('disposeObject3D', () => {
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
})
