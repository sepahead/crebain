import { describe, expect, it, vi } from 'vitest'
import { runSceneRestoreTransaction } from '../sceneRestoreTransaction'

describe('runSceneRestoreTransaction', () => {
  it.each(['loader', 'spawn'])(
    'rolls back an ordinary %s failure and never resumes physics',
    async (failure) => {
      const partial = {
        cameras: ['camera'],
        drones: ['drone'],
        assets: ['asset'],
        detectionEnabled: true,
        physicsPaused: true,
      }
      const commit = vi.fn(() => {
        partial.physicsPaused = false
      })
      const rollback = vi.fn(() => {
        partial.cameras = []
        partial.drones = []
        partial.assets = []
        partial.detectionEnabled = false
        partial.physicsPaused = true
      })

      await expect(
        runSceneRestoreTransaction(
          async () => {
            throw new Error(`${failure} failed`)
          },
          { isCurrent: () => true, rollback, commit }
        )
      ).rejects.toThrow(`${failure} failed`)

      expect(rollback).toHaveBeenCalledOnce()
      expect(commit).not.toHaveBeenCalled()
      expect(partial).toEqual({
        cameras: [],
        drones: [],
        assets: [],
        detectionEnabled: false,
        physicsPaused: true,
      })
    }
  )

  it('does not let a superseded restore roll back or commit the current generation', async () => {
    const rollback = vi.fn()
    const commit = vi.fn()
    await expect(
      runSceneRestoreTransaction(async () => Promise.reject(new Error('superseded')), {
        isCurrent: () => false,
        rollback,
        commit,
      })
    ).rejects.toThrow('superseded')

    expect(rollback).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits requested physics state only after the full operation succeeds', async () => {
    const rollback = vi.fn()
    const commit = vi.fn()

    await runSceneRestoreTransaction(async () => undefined, {
      isCurrent: () => true,
      rollback,
      commit,
    })

    expect(rollback).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledOnce()
  })
})
