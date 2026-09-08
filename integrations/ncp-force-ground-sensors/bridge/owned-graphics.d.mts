import type { EnvironmentGraphics } from '../../../src/environment/EnvironmentOwner'
export class OwnedGraphicsProcess implements EnvironmentGraphics {
  static prepare(
    plan: string,
    options: { timeoutMs: number; nodeExecutable: string }
  ): Promise<OwnedGraphicsProcess>
  captureJson(input: string): Promise<string>
  diagnostics(): ReturnType<EnvironmentGraphics['diagnostics']>
  retire(): Promise<void>
}
