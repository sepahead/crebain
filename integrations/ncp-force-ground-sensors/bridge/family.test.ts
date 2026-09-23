import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EnvironmentForkError } from '../../../src/environment/EnvironmentOwner'
import { NativeCheckpointFamily, familyReservationBytes } from './family'
import { sha256, validateFrozen } from './codec'
import {
  FamilyHarness,
  SyntheticCheckpointOwner,
  digest,
  familyPlan,
  neutral,
  sourceIdentity,
} from './family-fixtures.test-support'
import { PRESSURE_TARGET_DIGEST, pressureWindowRms } from './pressure-window'
import type { Checkpointed, CommittedStamp, FamilyPlan } from './family-types'

async function restored(harness: FamilyHarness, checkpoint: Checkpointed, slot: number) {
  const branch = harness.plan.branches[slot - 1]
  const request = digest(['reserve', slot])
  const reservation = harness.family.reserve(
    structuredClone(checkpoint.reference),
    branch.case_id,
    harness.lastStamp.get(0)!.result_digest,
    request
  )
  harness.family.observeReservationCommit(harness.stamp(0, request))
  const restored = await harness.family.restore(reservation, digest(harness.plan))
  harness.observeRestore(slot, restored.ancestry)
  return { reservation, restored }
}

async function terminal(harness: FamilyHarness, slot: number): Promise<CommittedStamp> {
  for (let tick = harness.plan.landmark_tick + 1; tick <= harness.plan.body.planned_ticks; tick++)
    await harness.advance(
      slot,
      tick,
      tick === harness.plan.landmark_tick + 1 ? harness.plan.branches[slot - 1].target : undefined
    )
  const result = await harness.family.evaluate(
    slot,
    harness.lastBatch.get(slot)!,
    PRESSURE_TARGET_DIGEST
  )
  expect(result.segments.reduce((sum, row) => sum + row.byte_length, 0)).toBe(3200)
  expect(result.scientific_validation).toBe(false)
  const evaluation = harness.stamp(slot)
  harness.family.observeEvaluationCommit(slot, evaluation)
  await harness.family.finishBranch(slot, evaluation.result_digest)
  const stamp = harness.stamp(slot)
  harness.family.observeBranchTerminal(stamp)
  return stamp
}

describe('live checkpoint family: synthetic component controls, no native qualification', () => {
  test('two matched siblings retain origin authority and close before canonical Finish', async () => {
    const harness = new FamilyHarness()
    const checkpoint = await harness.selectedCanonical()
    const executionDigest = harness.lastStamp.get(0)!.result_digest
    const original = [...harness.parent!.checkpoints.keys()][0]
    const initialCpu = harness.parent!.checkpointAudit(original).cpuCheckpointJson
    const first = await restored(harness, checkpoint, 1)
    expect(first.restored.cpu_state_sha256).toBe(checkpoint.cpu_state_sha256)
    expect(first.restored.pixels).toEqual(checkpoint.pixels)
    expect(first.restored.ancestry.origin_engine_run_id).toBe(
      `ncp-${harness.plan.canonical_binding.run_id}`
    )
    expect(first.restored.ancestry.execution_binding.run_id).not.toBe(
      harness.plan.canonical_binding.run_id
    )
    await expect(harness.family.finishCanonical([])).rejects.toThrow()
    expect(() =>
      harness.family.releaseCheckpoint(checkpoint.reference, digest('not-terminal'))
    ).toThrow()
    const terminals = [await terminal(harness, 1)]
    expect(() => harness.family.observeBranchChannelClosed(terminals[0])).toThrow()
    harness.family.observeBranchAckSent(terminals[0])
    expect(() =>
      harness.family.reserve(checkpoint.reference, 'case-2', executionDigest, digest('next'))
    ).toThrow()
    harness.family.observeBranchChannelClosed(terminals[0])
    // Selected execution is a frozen canonical result, not the later reservation result.
    const request = digest(['reserve', 2])
    const reservation = harness.family.reserve(
      structuredClone(checkpoint.reference),
      'case-2',
      executionDigest,
      request
    )
    harness.family.observeReservationCommit(harness.stamp(0, request))
    const second = await harness.family.restore(reservation, digest(harness.plan))
    harness.observeRestore(2, second.ancestry)
    expect(second.ancestry.native_owner_id).not.toBe(first.restored.ancestry.native_owner_id)
    expect(second.ancestry.graphics_generation).not.toBe(
      first.restored.ancestry.graphics_generation
    )
    expect(second.cpu_state_sha256).toBe(first.restored.cpu_state_sha256)
    terminals.push(await terminal(harness, 2))
    harness.family.observeBranchAckSent(terminals[1])
    harness.family.observeBranchChannelClosed(terminals[1])
    expect(harness.parent!.checkpointAudit(original).cpuCheckpointJson).toBe(initialCpu)
    harness.family.releaseCheckpoint(checkpoint.reference, terminals[1].result_digest)
    expect(() =>
      harness.family.reserve(checkpoint.reference, 'case-2', executionDigest, request)
    ).toThrow()
    harness.family.observeCheckpointReleaseCommit(harness.stamp(0))
    await harness.family.finishCanonical(terminals)
    expect(harness.parent!.retired).toBe(true)
    expect(harness.parent!.children.every((child) => child.retired)).toBe(true)
    expect(await harness.family.retire()).toBe(true)
  })

  test('all 16 endpoint reservations are charged before native construction', () => {
    const plan = familyPlan(15)
    let factoryCalls = 0
    const family = new NativeCheckpointFamily(plan, digest(plan), sourceIdentity, async () => {
      factoryCalls++
      throw new Error('not called')
    })
    expect(family.reservationBytes.sdk_owners_and_clients).toBe(37552128)
    expect(family.reservationBytes.frame_queues).toBe(2097152)
    expect(family.reservationBytes.ingress_requested_stack).toBe(4194304)
    expect(family.reservationBytes.guardian_diagnostic_prefix).toBe(131072)
    expect(family.reservationBytes.pressure_window).toBe(3200)
    expect(family.reservationBytes.client_pressure_window).toBe(3200)
    expect(factoryCalls).toBe(0)
    expect(() => familyReservationBytes(17, 1024)).toThrow()
    expect(() => familyReservationBytes(2.5, 1024)).toThrow()
    expect(() => familyReservationBytes(2, 33554433)).toThrow()
    expect(() => new FamilyHarness(familyPlan(16))).toThrow()
  })

  test('foreign bindings, duplicate slots, wrong function, window and barrier fail before factory', () => {
    const mutations = [
      (plan: Record<string, unknown>) => {
        plan.landmark_tick = 2
      },
      (plan: Record<string, unknown>) => {
        ;(plan.limits as Record<string, unknown>).endpoint_count = 4
      },
      (plan: Record<string, unknown>) => {
        ;(plan.evaluation as Record<string, unknown>).target_function_digest =
          digest('another-function')
      },
      (plan: Record<string, unknown>) => {
        ;(plan.evaluation as Record<string, unknown>).first_tick = 3
      },
      (plan: Record<string, unknown>) => {
        const branches = plan.branches as Array<Record<string, unknown>>
        branches[1].slot = 1
      },
      (plan: Record<string, unknown>) => {
        const branches = plan.branches as Array<Record<string, unknown>>
        branches[1].binding = branches[0].binding
      },
      (plan: Record<string, unknown>) => {
        plan.checkpoint_json = '{}'
      },
    ]
    for (const mutate of mutations) {
      const plan = structuredClone(familyPlan()) as unknown as Record<string, unknown>
      mutate(plan)
      expect(() => new FamilyHarness(plan as unknown as FamilyPlan)).toThrow()
    }
    expect(() => new FamilyHarness(familyPlan())).not.toThrow()
  })

  test('caller mutations cannot change the frozen family plan', () => {
    const input = familyPlan()
    const harness = new FamilyHarness(input)
    ;(input.branches[0].target as { pitch_rad: number }).pitch_rad = 0.03
    expect(harness.family.plan.branches[0].target.pitch_rad).toBe(0)
    expect(Object.isFrozen(harness.family.plan.branches[0].target)).toBe(true)
    expect(() => {
      ;(harness.family.plan.limits as { endpoint_count: number }).endpoint_count = 16
    }).toThrow()
  })

  test('native execution cannot follow uncommitted preparation or decision', async () => {
    const harness = new FamilyHarness()
    await harness.family.prepare()
    await expect(
      harness.family.advance(0, harness.command(0, 1, neutral), digest('first'))
    ).rejects.toThrow()
    expect(harness.parent!.tick).toBe(0)
    harness.family.observePrepareCommit(harness.stamp(0))
    for (let tick = 1; tick <= 3; tick++)
      await harness.advance(0, tick, tick === 1 ? neutral : undefined)
    const checkpoint = await harness.family.createCheckpoint(harness.lastBatch.get(0)!)
    expect(() =>
      harness.family.select(checkpoint.reference, 'case-1', digest('forecast'))
    ).toThrow()
    harness.family.observeCheckpointCommit(harness.stamp(0))
    harness.family.select(checkpoint.reference, 'case-1', digest('forecast'))
    await expect(
      harness.family.advance(0, harness.command(0, 4, neutral), digest('selected'))
    ).rejects.toThrow()
    expect(harness.parent!.tick).toBe(3)
    harness.family.observeDecisionCommit(harness.stamp(0))
    await harness.advance(0, 4, neutral)
    expect(harness.parent!.tick).toBe(4)
    expect(await harness.family.retire()).toBe(true)
  })

  test('native-handle copies are rejected while authorized family selectors remain reusable', async () => {
    const harness = new FamilyHarness()
    const checkpoint = await harness.selectedCanonical()
    const handle = [...harness.parent!.checkpoints.keys()][0]
    await expect(harness.parent!.fork({ ...handle })).rejects.toThrow()
    expect(() =>
      harness.family.reserve(
        { ...checkpoint.reference, checkpoint_token: crypto.randomUUID() },
        'case-1',
        harness.lastStamp.get(0)!.result_digest,
        digest('reserve')
      )
    ).toThrow()
    expect(() =>
      harness.family.reserve(
        { ...checkpoint.reference, family_id: crypto.randomUUID() },
        'case-1',
        harness.lastStamp.get(0)!.result_digest,
        digest('reserve')
      )
    ).toThrow()
    const result = await restored(harness, structuredClone(checkpoint), 1)
    expect(result.restored.ancestry.origin).toEqual(checkpoint.reference)
    await expect(harness.family.restore(result.reservation, digest(harness.plan))).rejects.toThrow()
    expect(await harness.family.retire()).toBe(true)
  })

  test('restored preparation commit, exact action and inherited ancestry are required', async () => {
    const harness = new FamilyHarness()
    const checkpoint = await harness.selectedCanonical()
    const request = digest('reserve')
    const reservation = harness.family.reserve(
      checkpoint.reference,
      'case-1',
      harness.lastStamp.get(0)!.result_digest,
      request
    )
    await expect(harness.family.restore(reservation, digest(harness.plan))).rejects.toThrow()
    harness.family.observeReservationCommit(harness.stamp(0, request))
    const restored = await harness.family.restore(reservation, digest(harness.plan))
    await expect(
      harness.family.advance(1, harness.command(1, 4, neutral), digest('action'))
    ).rejects.toThrow()
    harness.observeRestore(1, restored.ancestry)
    await expect(
      harness.family.advance(
        1,
        harness.command(1, 4, { ...neutral, pitch_rad: 0.03 }),
        digest('changed')
      )
    ).rejects.toThrow()
    expect(harness.parent!.children[0].tick).toBe(3)
    harness.parent!.children[0].corruptAncestry = true
    await expect(harness.advance(1, 4, neutral)).rejects.toThrow('Actual source observation join')
    expect(harness.parent!.children[0].tick).toBe(4) // Executed, then rejected output; never a pre-execution claim.
    expect(await harness.family.retire()).toBe(true)
  })

  test('CPU or current-pixel mismatch retires the failed family without admitting a branch', async () => {
    for (const field of ['mismatchCpu', 'mismatchPixels'] as const) {
      const harness = new FamilyHarness()
      const checkpoint = await harness.selectedCanonical()
      harness.parent![field] = true
      await expect(restored(harness, checkpoint, 1)).rejects.toThrow(
        'Native restored state or current pixels differ'
      )
      expect(await harness.family.retire()).toBe(true)
      expect(harness.parent!.children[0].retired).toBe(true)
      expect(harness.parent!.children[0].checkpoints.size).toBe(0)
    }
  })

  test('unknown fork cleanup stays unresolved after successful parent retirement', async () => {
    for (const error of [
      new Error('no child capability returned'),
      new EnvironmentForkError('renderer failed', [], false),
    ]) {
      const harness = new FamilyHarness()
      const checkpoint = await harness.selectedCanonical()
      harness.parent!.failFork = error
      await expect(restored(harness, checkpoint, 1)).rejects.toBe(error)
      expect(await harness.family.retire()).toBe(false)
      expect(await harness.family.retire()).toBe(false)
      expect(harness.parent!.retired).toBe(true)
    }
    const harness = new FamilyHarness()
    const checkpoint = await harness.selectedCanonical()
    harness.parent!.failFork = new EnvironmentForkError('CPU mismatch', [], true)
    await expect(restored(harness, checkpoint, 1)).rejects.toThrow()
    expect(await harness.family.retire()).toBe(true)
  })

  test('native retirement failure cannot be promoted by a later repeated cleanup', async () => {
    const harness = new FamilyHarness()
    const checkpoint = await harness.selectedCanonical()
    await restored(harness, checkpoint, 1)
    const child = harness.parent!.children[0]
    child.failRetire = true
    expect(await harness.family.retire()).toBe(false)
    child.failRetire = false
    expect(await harness.family.retire()).toBe(false)
    expect(child.retirementCalls).toBe(1)
  })

  test('absolute deadline and clock regression reject before further native execution', async () => {
    let now = 100
    const harness = new FamilyHarness(familyPlan(), () => now)
    await harness.family.prepare()
    harness.family.observePrepareCommit(harness.stamp(0))
    now = 600100
    await expect(harness.advance(0, 1, neutral)).rejects.toThrow()
    expect(harness.parent!.tick).toBe(0)
    now = 99
    await expect(harness.advance(0, 1, neutral)).rejects.toThrow()
    expect(await harness.family.retire()).toBe(true)
  })

  test('a fresh backward clock after progress fails permanently, while forward progress passes', async () => {
    let now = 100
    const harness = new FamilyHarness(familyPlan(), () => now)
    await harness.family.prepare()
    now = 200
    harness.family.observePrepareCommit(harness.stamp(0))
    now = 150
    await expect(harness.advance(0, 1, neutral)).rejects.toThrow()
    expect(harness.parent!.tick).toBe(0)
    now = 250
    await expect(harness.advance(0, 1, neutral)).rejects.toThrow()
    expect(await harness.family.retire()).toBe(true)
    const fresh = new FamilyHarness(familyPlan(), () => now)
    await fresh.family.prepare()
    now = 300
    fresh.family.observePrepareCommit(fresh.stamp(0))
    now = 350
    await fresh.advance(0, 1, neutral)
    expect(fresh.parent!.tick).toBe(1)
    expect(await fresh.family.retire()).toBe(true)
  })

  test('the final canonical summary is construction evidence until its exact result commits', async () => {
    const harness = new FamilyHarness(familyPlan(1))
    let attempted = false
    harness.transformCommit = (value, stamp) => {
      if (value.canonical_final_state) {
        attempted = true
        const handle = [...harness.parent!.checkpoints.keys()][0]
        expect(() =>
          harness.family.reserve(
            {
              family_id: harness.plan.family_id,
              checkpoint_token: crypto.randomUUID(),
              parent_binding: harness.plan.canonical_binding,
              parent_native_owner_id: harness.parent!.ownerId,
              tick: handle.tick,
              checkpoint_sha256: handle.sha256,
            },
            'case-1',
            stamp.result_digest,
            digest('early')
          )
        ).toThrow()
        return {
          ...value,
          canonical_final_state: {
            ...value.canonical_final_state,
            cpu_state_sha256: digest('altered-summary'),
          },
        }
      }
      return value
    }
    await expect(harness.selectedCanonical()).rejects.toThrow(
      'SDK result differs from the native transition'
    )
    expect(attempted).toBe(true)
    expect(harness.parent!.tick).toBe(6)
    expect(await harness.family.retire()).toBe(true)
  })

  test('a correct checkpoint selector still cannot reserve before the final Advanced commits', async () => {
    const harness = new FamilyHarness(familyPlan(1))
    await harness.family.prepare()
    harness.family.observePrepareCommit(harness.stamp(0))
    for (let tick = 1; tick <= 3; tick++)
      await harness.advance(0, tick, tick === 1 ? neutral : undefined)
    const checkpoint = await harness.family.createCheckpoint(harness.lastBatch.get(0)!)
    harness.family.observeCheckpointCommit(harness.stamp(0))
    harness.family.select(checkpoint.reference, 'case-1', digest('forecast'))
    harness.family.observeDecisionCommit(harness.stamp(0))
    let attempted = false
    harness.transformCommit = (value, stamp) => {
      if (value.canonical_final_state) {
        attempted = true
        expect(() =>
          harness.family.reserve(
            checkpoint.reference,
            'case-1',
            stamp.result_digest,
            digest('early')
          )
        ).toThrow()
      }
      return value
    }
    for (let tick = 4; tick <= 6; tick++)
      await harness.advance(0, tick, tick === 4 ? neutral : undefined)
    expect(attempted).toBe(true)
    expect(() =>
      harness.family.reserve(
        checkpoint.reference,
        'case-1',
        harness.lastStamp.get(0)!.result_digest,
        digest('admitted')
      )
    ).not.toThrow()
    expect(await harness.family.retire()).toBe(true)
  })

  test('same-action final CPU mismatch fails before evaluation can commit', async () => {
    const harness = new FamilyHarness(familyPlan(1))
    const checkpoint = await harness.selectedCanonical()
    await restored(harness, checkpoint, 1)
    for (let tick = 4; tick <= 6; tick++)
      await harness.advance(1, tick, tick === 4 ? neutral : undefined)
    harness.parent!.children[0].mismatchCpu = true
    await expect(
      harness.family.evaluate(1, harness.lastBatch.get(1)!, PRESSURE_TARGET_DIGEST)
    ).rejects.toThrow('Matched selected action changed the complete final CPU state')
    expect(await harness.family.retire()).toBe(true)
  })

  test('parent state mutation during labels fails the terminal recheck', async () => {
    const harness = new FamilyHarness(familyPlan(1))
    const checkpoint = await harness.selectedCanonical()
    await restored(harness, checkpoint, 1)
    const stamp = await terminal(harness, 1)
    harness.family.observeBranchAckSent(stamp)
    harness.family.observeBranchChannelClosed(stamp)
    harness.family.releaseCheckpoint(checkpoint.reference, stamp.result_digest)
    harness.family.observeCheckpointReleaseCommit(harness.stamp(0))
    harness.parent!.mismatchCpu = true
    await expect(harness.family.finishCanonical([stamp])).rejects.toThrow(
      'Canonical complete state changed during branch evaluation'
    )
    expect(await harness.family.retire()).toBe(true)
  })

  test('temporary audit and release failures preserve both original exception objects', async () => {
    const harness = new FamilyHarness(familyPlan(1))
    const checkpoint = await harness.selectedCanonical()
    const primary = new Error('owned audit failure'),
      cleanup = new Error('owned release failure')
    const originalFork = harness.parent!.fork.bind(harness.parent!)
    harness.parent!.fork = async (handle) => {
      const child = await originalFork(handle)
      child.checkpointAudit = () => {
        throw primary
      }
      child.releaseCheckpoint = () => {
        throw cleanup
      }
      return child
    }
    let failure: unknown
    try {
      await restored(harness, checkpoint, 1)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([primary, cleanup])
    expect((failure as AggregateError).errors[0]).toBe(primary)
    expect((failure as AggregateError).errors[1]).toBe(cleanup)
    expect(await harness.family.retire()).toBe(true)
  })

  test('pre-yield preparation cancellation awaits and retires the late actual owner', async () => {
    const plan = familyPlan()
    let resolve!: (owner: SyntheticCheckpointOwner) => void
    let owner: SyntheticCheckpointOwner | null = null
    const family = new NativeCheckpointFamily(
      plan,
      digest(plan),
      sourceIdentity,
      async (nativePlan) => {
        owner = new SyntheticCheckpointOwner(nativePlan)
        return new Promise((done) => {
          resolve = done
        })
      }
    )
    const preparing = family.prepare()
    await new Promise((done) => setTimeout(done, 0))
    const retiring = family.retire()
    expect(owner).not.toBeNull()
    resolve(owner!)
    await expect(preparing).rejects.toThrow()
    expect(await retiring).toBe(true)
    expect((owner as SyntheticCheckpointOwner | null)?.retired).toBe(true)
  })

  test('ordinary roles cannot acquire family checkpoint or evaluation operations', () => {
    expect(() =>
      validateFrozen(
        'Command',
        { kind: 'checkpoint', tick: 3, expected_batch_digest: digest('batch') },
        'application'
      )
    ).toThrow()
    expect(() =>
      validateFrozen(
        'Command',
        {
          kind: 'evaluate_pressure_window',
          expected_batch_digest: digest('batch'),
          expected_target_function_digest: PRESSURE_TARGET_DIGEST,
        },
        'application'
      )
    ).toThrow()
    expect(() =>
      validateFrozen(
        'CanonicalCommand',
        { kind: 'checkpoint', tick: 3, expected_batch_digest: digest('batch') },
        'family'
      )
    ).not.toThrow()
    expect(() =>
      validateFrozen(
        'EvaluationCommand',
        { kind: 'checkpoint', tick: 3, expected_batch_digest: digest('batch') },
        'family'
      )
    ).toThrow()
    expect(() => validateFrozen('ImportDescriptor', {}, 'family')).toThrow()
  })
})

describe('ordered pressure target arithmetic', () => {
  test('all eight frozen independent Python and Node stress vectors match the selected Bun bits', () => {
    const vectors = JSON.parse(
      readFileSync(new URL('./pressure-window.vectors.v1.json', import.meta.url), 'utf8')
    ) as {
      target_function_sha256: string
      vectors: Array<{ payload_le_f64_hex: string; payload_sha256: string; rms_le_f64_hex: string }>
    }
    expect(vectors.target_function_sha256).toBe(PRESSURE_TARGET_DIGEST)
    expect(vectors.vectors.length).toBe(8)
    for (const row of vectors.vectors) {
      const payload = Buffer.from(row.payload_le_f64_hex, 'hex')
      expect(sha256(payload)).toBe(row.payload_sha256)
      const result = Buffer.alloc(8)
      result.writeDoubleLE(pressureWindowRms(payload))
      expect(result.toString('hex')).toBe(row.rms_le_f64_hex)
    }
  })
  test('installed target joins the frozen canonical JSON identity', () => {
    expect(PRESSURE_TARGET_DIGEST).toBe(
      '2587d58265dfec6decf9d2255a410ca195a337e1bbf1020ccaac4f37ee6c1505'
    )
  })
  test('zero signs, constants, extreme scales and original bytes remain well-defined', () => {
    const bytes = Buffer.alloc(3200)
    for (let offset = 0; offset < 3200; offset += 8) bytes.writeDoubleLE(-0, offset)
    const original = Buffer.from(bytes)
    expect(Object.is(pressureWindowRms(bytes), 0)).toBe(true)
    expect(bytes).toEqual(original)
    for (const scale of [1, 1e300, 1e-300]) {
      for (let index = 0; index < 400; index++)
        bytes.writeDoubleLE(index % 2 ? scale : -scale, index * 8)
      expect(pressureWindowRms(bytes)).toBe(scale)
    }
    bytes.fill(0)
    bytes.writeDoubleLE(20, 0)
    expect(pressureWindowRms(bytes)).toBe(1)
  })
  test('wrong length and nonfinite pressure never become a zero target', () => {
    expect(() => pressureWindowRms(Buffer.alloc(3192))).toThrow()
    expect(() => pressureWindowRms(Buffer.alloc(3208))).toThrow()
    for (const value of [NaN, Infinity, -Infinity]) {
      const bytes = Buffer.alloc(3200)
      bytes.writeDoubleLE(value, 64)
      expect(() => pressureWindowRms(bytes)).toThrow()
    }
  })
})
