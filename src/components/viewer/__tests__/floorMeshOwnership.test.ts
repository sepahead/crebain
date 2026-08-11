import { BufferGeometry, Mesh, MeshBasicMaterial, Scene } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { activateFloorMesh } from '../floorMeshOwnership'

function floor(): Mesh {
  return new Mesh(new BufferGeometry(), new MeshBasicMaterial())
}

describe('activateFloorMesh', () => {
  it('admits the replacement before detaching and disposing the previous floor', () => {
    const scene = new Scene()
    const previous = floor()
    const candidate = floor()
    scene.add(previous)
    const geometryDispose = vi.spyOn(previous.geometry, 'dispose')
    const materialDispose = vi.spyOn(previous.material as MeshBasicMaterial, 'dispose')

    const failures = activateFloorMesh(scene, previous, candidate)

    expect(failures).toEqual([])
    expect(scene.children).toContain(candidate)
    expect(scene.children).not.toContain(previous)
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(materialDispose).toHaveBeenCalledOnce()
  })

  it('keeps the previous floor and disposes a candidate rejected by the scene', () => {
    const previous = floor()
    const candidate = floor()
    const candidateGeometryDispose = vi.spyOn(candidate.geometry, 'dispose')
    const candidateMaterialDispose = vi.spyOn(candidate.material as MeshBasicMaterial, 'dispose')
    const remove = vi.fn()
    const scene = {
      add: vi.fn(() => {
        throw new Error('admission failed')
      }),
      remove,
    } as unknown as Scene

    expect(() => activateFloorMesh(scene, previous, candidate)).toThrow(
      'Floor admission and candidate cleanup failed'
    )
    expect(remove).toHaveBeenCalledWith(candidate)
    expect(candidateGeometryDispose).toHaveBeenCalledOnce()
    expect(candidateMaterialDispose).toHaveBeenCalledOnce()
  })

  it('accepts a candidate that attached before its added listener threw', () => {
    const scene = new Scene()
    const candidate = floor()
    const candidateGeometryDispose = vi.spyOn(candidate.geometry, 'dispose')
    vi.spyOn(scene, 'add').mockImplementation((object) => {
      Scene.prototype.add.call(scene, object)
      throw new Error('added listener failed')
    })

    const failures = activateFloorMesh(scene, null, candidate)

    expect(candidate.parent).toBe(scene)
    expect(candidateGeometryDispose).not.toHaveBeenCalled()
    expect(failures).toEqual([
      expect.objectContaining({ phase: 'attach-candidate', error: expect.any(Error) }),
    ])
  })

  it('keeps the admitted replacement live while reporting previous cleanup failures', () => {
    const scene = new Scene()
    const previous = floor()
    const candidate = floor()
    scene.add(previous)
    vi.spyOn(previous.geometry, 'dispose').mockImplementation(() => {
      throw new Error('dispose failed')
    })

    const failures = activateFloorMesh(scene, previous, candidate)

    expect(scene.children).toContain(candidate)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.phase).toBe('dispose-previous')
    expect(failures[0]?.error).toBeInstanceOf(AggregateError)
  })

  it('rolls the replacement back when the previous floor remains attached', () => {
    const scene = new Scene()
    const previous = floor()
    const candidate = floor()
    scene.add(previous)
    const remove = vi.spyOn(scene, 'remove').mockImplementation((object) => {
      if (object === previous) throw new Error('detach failed')
      return Scene.prototype.remove.call(scene, object)
    })
    const candidateGeometryDispose = vi.spyOn(candidate.geometry, 'dispose')
    const candidateMaterialDispose = vi.spyOn(candidate.material as MeshBasicMaterial, 'dispose')

    expect(() => activateFloorMesh(scene, previous, candidate)).toThrow(
      'previous floor stayed attached'
    )

    expect(scene.children).toContain(previous)
    expect(scene.children).not.toContain(candidate)
    expect(remove).toHaveBeenCalledWith(previous)
    expect(remove).toHaveBeenCalledWith(candidate)
    expect(candidateGeometryDispose).toHaveBeenCalledOnce()
    expect(candidateMaterialDispose).toHaveBeenCalledOnce()
  })

  it('rolls back when a nonthrowing removal listener reattaches the previous floor', () => {
    const scene = new Scene()
    const previous = floor()
    const candidate = floor()
    scene.add(previous)
    const reattach = () => scene.add(previous)
    previous.addEventListener('removed', reattach)
    const candidateGeometryDispose = vi.spyOn(candidate.geometry, 'dispose')

    expect(() => activateFloorMesh(scene, previous, candidate)).toThrow(
      'previous floor stayed attached'
    )

    expect(previous.parent).toBe(scene)
    expect(candidate.parent).toBeNull()
    expect(candidateGeometryDispose).toHaveBeenCalledOnce()
    previous.removeEventListener('removed', reattach)
  })
})
