import type {
  SourceGraphicsPort,
  SourceGraphicsInput,
  SourceGraphicsSelection,
  GraphicsSourceReceipt,
} from '../../../src/environment/GraphicsContract'
export class OwnedGraphicsProcess implements SourceGraphicsPort {
  static prepareSources(
    plan: string,
    options: { timeoutMs: number; nodeExecutable: string }
  ): Promise<OwnedGraphicsProcess>
  readonly planSha256: string
  captureSourceInto(
    input: SourceGraphicsInput,
    source: SourceGraphicsSelection,
    destination: Uint8Array
  ): Promise<GraphicsSourceReceipt>
  diagnostics(): unknown
  retire(): Promise<void>
}
