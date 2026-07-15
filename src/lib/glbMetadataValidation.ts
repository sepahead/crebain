export const MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT = 512 * 1024
export const MAX_GLB_METADATA_CLONE_BYTES = 16 * 1024 * 1024

type JsonRecord = Record<string, unknown>

export interface CloneableMetadataByteCounts {
  extras: number
  extensions: number
  total: number
}

export function cloneableMetadataByteCounts(
  value: JsonRecord,
  name: string
): CloneableMetadataByteCounts {
  const counts = { extras: 0, extensions: 0 }
  for (const key of ['extras', 'extensions'] as const) {
    if (value[key] === undefined) continue
    counts[key] = new TextEncoder().encode(JSON.stringify(value[key])).byteLength
    if (!Number.isSafeInteger(counts[key]))
      throw new Error(`${name} metadata exceeds safe integer bounds`)
  }
  const total = counts.extras + counts.extensions
  if (!Number.isSafeInteger(total)) throw new Error(`${name} metadata exceeds safe integer bounds`)
  if (total > MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT) {
    throw new Error(
      `${name} exceeds ${MAX_GLB_CLONEABLE_METADATA_BYTES_PER_OBJECT} cloneable metadata bytes`
    )
  }
  return { ...counts, total }
}

export function cloneableMetadataBytes(value: JsonRecord, name: string): number {
  return cloneableMetadataByteCounts(value, name).total
}
