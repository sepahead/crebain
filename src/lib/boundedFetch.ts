/** Fetch a binary asset while enforcing the byte ceiling during streaming,
 * including when Content-Length is absent or dishonest. */
export async function fetchAssetWithLimit(
  source: string,
  maxBytes: number,
  signal: AbortSignal,
  onProgress?: (received: number, total: number | null) => void
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Asset byte limit must be a positive safe integer')
  }

  const response = await fetch(source, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const contentLengthHeader = response.headers.get('Content-Length')
  const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : Number.NaN
  const total = Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null
  if (total !== null && total > maxBytes) {
    await response.body?.cancel('Asset size limit exceeded')
    throw new Error(`Asset is too large (${total} bytes; maximum ${maxBytes})`)
  }

  if (!response.body) {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Asset is too large (${bytes.byteLength} bytes; maximum ${maxBytes})`)
    }
    onProgress?.(bytes.byteLength, total)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel('Asset size limit exceeded')
        throw new Error(`Asset exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
      onProgress?.(received, total)
    }
  } finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined.buffer
}

/** Read a browser-selected file while preserving cancellation through FileReader. */
export function readFileAsArrayBuffer(
  file: File,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('File read aborted', 'AbortError')

    if (signal.aborted) {
      reject(abortError())
      return
    }

    const reader = new FileReader()
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      if (reader.readyState === FileReader.LOADING) reader.abort()
      else fail(abortError())
    }

    signal.addEventListener('abort', abort, { once: true })
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total)
    }
    reader.onload = () => {
      if (settled) return
      if (!(reader.result instanceof ArrayBuffer)) {
        fail(new Error('File read returned an invalid result'))
        return
      }
      settled = true
      cleanup()
      resolve(reader.result)
    }
    reader.onerror = () => fail(reader.error ?? new Error('File read failed'))
    reader.onabort = () => fail(abortError())
    reader.readAsArrayBuffer(file)
  })
}
