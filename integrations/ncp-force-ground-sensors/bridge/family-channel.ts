import { NativeCheckpointFamily, type CheckpointOwnerFactory } from './family'
import type { PrivateCommand } from './family-engine-types'

/** Closed dispatcher selected by the trusted Rust host, never by an NCP peer. */
export class FamilyChannel {
  private family: NativeCheckpointFamily | null = null
  private readonly leases = new Map<number, { tick: number; digest: string }>()
  private ended = false

  constructor(private readonly factory: CheckpointOwnerFactory) {}

  get complete(): boolean {
    return this.ended
  }
  get plan(): NativeCheckpointFamily['plan'] | null {
    return this.family?.plan ?? null
  }
  get planDigest(): string | null {
    return this.family?.familyPlanDigest ?? null
  }

  async command(command: PrivateCommand): Promise<unknown> {
    if (this.ended) throw new Error('Family bridge already ended')
    if (command.kind === 'construct') {
      if (this.family) throw new Error('Family bridge already constructed')
      this.family = new NativeCheckpointFamily(
        command.plan,
        command.family_plan_digest,
        command.source_identity,
        this.factory
      )
      return { kind: 'constructed' }
    }
    if (command.kind === 'retire') {
      const cleanup = await this.retire()
      if (!cleanup) throw new Error('Family retirement unresolved')
      return { kind: 'retired', cleanup_confirmed: true }
    }
    const family = this.family
    if (!family) throw new Error('Family bridge is not constructed')
    switch (command.kind) {
      case 'prepare':
        return { kind: 'prepared', ...(await family.prepare()) }
      case 'advance': {
        if (this.leases.size) throw new Error('Prior native lease remains retained')
        const result = await family.advance(command.slot, command.command, command.request_digest)
        this.leases.set(command.slot, {
          tick: result.batch.body_tick,
          digest: result.batch.engine_batch_sha256,
        })
        return result
      }
      case 'read_chunk': {
        this.checkLease(command.slot, command.tick, command.engine_batch_sha256)
        return family.readChunk(command.slot, command.sensor_id, command.offset, command.count)
      }
      case 'release_lease': {
        this.checkLease(command.slot, command.tick, command.engine_batch_sha256)
        const canonical_final_state = await family.releaseLease(command.slot)
        this.leases.delete(command.slot)
        return {
          kind: 'released',
          tick: command.tick,
          engine_batch_sha256: command.engine_batch_sha256,
          canonical_final_state,
        }
      }
      case 'checkpoint':
        return {
          kind: 'checkpointed',
          result: await family.createCheckpoint(command.expected_batch_digest),
        }
      case 'select':
        return {
          kind: 'selected',
          result: family.select(command.checkpoint, command.case_id, command.forecast),
        }
      case 'reserve':
        return {
          kind: 'reserved',
          reference: family.reserve(
            command.checkpoint,
            command.case_id,
            command.selected,
            command.request
          ),
        }
      case 'restore':
        return {
          kind: 'restored',
          result: await family.restore(command.reservation, command.family_plan_digest),
        }
      case 'evaluate':
        return {
          kind: 'evaluated',
          result: await family.evaluate(command.slot, command.batch, command.target),
        }
      case 'finish_branch':
        await family.finishBranch(command.slot, command.evaluation)
        return { kind: 'branch_finished' }
      case 'release_checkpoint':
        family.releaseCheckpoint(command.checkpoint, command.terminal)
        return { kind: 'checkpoint_released' }
      case 'finish_canonical': {
        const state = await family.finishCanonical(command.terminals)
        this.ended = true
        return { kind: 'family_finished', state }
      }
      case 'observe_canonical': {
        const { stamp, result } = command
        switch (result.kind) {
          case 'family_prepared':
            family.observePrepareCommit(stamp)
            break
          case 'family_advanced':
            family.observeAdvanceCommit(0, stamp, result)
            break
          case 'checkpointed':
            family.observeCheckpointCommit(stamp)
            break
          case 'decision_committed':
            family.observeDecisionCommit(stamp)
            break
          case 'branch_reserved':
            family.observeReservationCommit(stamp)
            break
          case 'checkpoint_released':
            family.observeCheckpointReleaseCommit(stamp)
            break
        }
        return { kind: 'observed' }
      }
      case 'observe_evaluation': {
        const { slot, stamp, result } = command
        switch (result.kind) {
          case 'restored':
            family.observeRestoreCommit(slot, stamp)
            break
          case 'family_advanced':
            family.observeAdvanceCommit(slot, stamp, result)
            break
          case 'pressure_window_evaluated':
            family.observeEvaluationCommit(slot, stamp)
            break
        }
        return { kind: 'observed' }
      }
      case 'observe_terminal':
        family.observeBranchTerminal(command.stamp)
        return { kind: 'observed' }
      case 'observe_ack':
        family.observeBranchAckSent(command.stamp)
        return { kind: 'observed' }
      case 'observe_eof':
        family.observeBranchChannelClosed(command.stamp)
        return { kind: 'observed' }
    }
  }

  private checkLease(slot: number, tick: number, digest: string): void {
    const lease = this.leases.get(slot)
    if (!lease || lease.tick !== tick || lease.digest !== digest)
      throw new Error('Family native lease identity')
  }

  async retire(): Promise<boolean> {
    this.ended = true
    const confirmed = this.family ? await this.family.retire() : true
    if (confirmed) this.leases.clear()
    return confirmed
  }
}
