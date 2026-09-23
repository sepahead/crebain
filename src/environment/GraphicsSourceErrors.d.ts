/** Shared import-light local classification; no remote process or cleanup authority. */
export class GraphicsSourceIntegrityError extends Error {
  constructor(message: string, cause?: unknown)
}
export class SourceGraphicsTransferError extends Error {
  readonly category: 'acquisition' | 'integrity'
  constructor(category: 'acquisition' | 'integrity', message: string, cause?: unknown)
}
export function isGraphicsSourceIntegrityError(value: unknown): boolean
export function sourceCleanupFailure(
  primary: unknown,
  cleanup: unknown,
  message: string
): SourceGraphicsTransferError
