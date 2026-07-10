import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAssetWithLimit } from '../boundedFetch'

function streamingResponse(chunks: number[][], contentLength?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new Uint8Array(chunk)))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: contentLength === undefined ? undefined : { 'Content-Length': String(contentLength) },
  })
}

describe('fetchAssetWithLimit', () => {
  afterEach(() => vi.restoreAllMocks())

  it('streams a bounded asset and reports cumulative progress', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(streamingResponse([[1, 2], [3]], 3))
    const progress = vi.fn()
    const controller = new AbortController()

    const result = await fetchAssetWithLimit('/asset.glb', 3, controller.signal, progress)

    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3])
    expect(progress.mock.calls).toEqual([
      [2, 3],
      [3, 3],
    ])
    expect(fetchMock).toHaveBeenCalledWith('/asset.glb', { signal: controller.signal })
  })

  it('rejects an oversized declared length before buffering the body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse([[1]], 100))

    await expect(
      fetchAssetWithLimit('/oversized.splat', 10, new AbortController().signal)
    ).rejects.toThrow('Asset is too large')
  })

  it('rejects a stream that exceeds a missing or dishonest length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamingResponse([[1, 2], [3]], 2))

    await expect(
      fetchAssetWithLimit('/dishonest.glb', 2, new AbortController().signal)
    ).rejects.toThrow('Asset exceeds maximum size')
  })

  it('rejects invalid byte limits without making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(
      fetchAssetWithLimit('/asset.glb', 0, new AbortController().signal)
    ).rejects.toThrow('positive safe integer')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
