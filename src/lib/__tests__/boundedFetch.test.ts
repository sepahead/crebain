import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAssetWithLimit, readFileAsArrayBuffer } from '../boundedFetch'

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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

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

  it('aborts a superseded file read while a newer acquisition completes', async () => {
    const readers: ControlledFileReader[] = []
    class ControlledFileReader {
      static readonly LOADING = 1
      readyState = 0
      result: ArrayBuffer | null = null
      error: DOMException | null = null
      onabort: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onprogress: ((event: ProgressEvent<FileReader>) => void) | null = null
      abortCalls = 0

      constructor() {
        readers.push(this)
      }

      readAsArrayBuffer(): void {
        this.readyState = ControlledFileReader.LOADING
      }

      abort(): void {
        this.abortCalls += 1
        this.readyState = 2
        this.onabort?.(new ProgressEvent('abort') as ProgressEvent<FileReader>)
      }

      complete(bytes: Uint8Array): void {
        this.result = bytes.slice().buffer
        this.readyState = 2
        this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
      }
    }
    vi.stubGlobal('FileReader', ControlledFileReader)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const file = new File([new Uint8Array([1, 2, 3])], 'scene.splat')

    const first = readFileAsArrayBuffer(file, firstController.signal)
    const second = readFileAsArrayBuffer(file, secondController.signal)
    firstController.abort(new Error('superseded'))

    await expect(first).rejects.toThrow('superseded')
    expect(readers[0].abortCalls).toBe(1)
    readers[1].complete(new Uint8Array([4, 5]))
    await expect(second).resolves.toEqual(new Uint8Array([4, 5]).buffer)
  })
})
