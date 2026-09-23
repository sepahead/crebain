import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SOURCE_PLAN_BYTES,
  SOURCE_INPUT_BYTES,
  SOURCE_CHUNK_BYTES,
  SourceGraphicsTransferError,
  sourceDigest,
  encodeSourceJson,
  parseSourceJson,
  copyRetainedSource,
} from './lib/source-graphics-codec.mjs'

function fixture(width = 128, height = 128) {
  const source = { kind: 'rgb', cameraId: 'actual-camera' }
  const planSha256 = 'a'.repeat(64)
  const input = { planSha256, tick: 2, drones: [{ id: 'drone', position: [-0, 1, 2] }] }
  const plan = {
    scene: {
      rgbCameras: [{ id: source.cameraId, width, height, periodTicks: 2 }],
      thermalCameras: [],
    },
  }
  const original = Buffer.alloc(4 * width * height)
  for (let i = 0; i < original.length; i++) original[i] = i % 251
  const lease = {
    schema: 'crebain.private-graphics-source.v1',
    sequence: 1,
    originalSha256: sourceDigest(original),
    receipt: {
      planSha256,
      inputSha256: sourceDigest(encodeSourceJson(input, SOURCE_INPUT_BYTES)),
      tick: 2,
      kind: 'rgb',
      cameraId: source.cameraId,
      width,
      height,
      rowOrigin: 'bottom-left',
      encoding: 'rgba8-srgb',
      byteLength: original.length,
    },
  }
  const calls = []
  let alter = (_operation, value) => value
  const request = async (operation, body) => {
    calls.push({ operation, body })
    let result
    if (operation === 'capture_source') {
      assert.ok(
        Object.is(parseSourceJson(body.inputJson, SOURCE_INPUT_BYTES).drones[0].position[0], -0)
      )
      result = structuredClone(lease)
    } else if (operation === 'read_source') {
      const bytes = original.subarray(body.offset, body.offset + SOURCE_CHUNK_BYTES)
      result = { ...body, bytesBase64: bytes.toString('base64'), chunkSha256: sourceDigest(bytes) }
    } else if (operation === 'release_source') result = { ...body, released: true }
    else throw new Error('Unexpected private source operation')
    return alter(operation, result)
  }
  const destination = new Uint8Array(original.length)
  return {
    plan,
    source,
    input,
    planSha256,
    original,
    lease,
    request,
    calls,
    destination,
    alter(fn) {
      alter = fn
    },
    copy() {
      return copyRetainedSource(request, plan, planSha256, input, source, destination, 1)
    },
  }
}

test('finite signed-zero codec retains exact numeric values and explicit byte limits', () => {
  const value = { numbers: [-0, 0, Number.MIN_VALUE, Number.MAX_VALUE, -1.25] }
  const text = encodeSourceJson(value, SOURCE_PLAN_BYTES)
  assert.deepEqual(parseSourceJson(text, SOURCE_PLAN_BYTES), value)
  assert.ok(Object.is(parseSourceJson(text, SOURCE_PLAN_BYTES).numbers[0], -0))
  assert.equal(encodeSourceJson('a', 3), '"a"')
  assert.throws(() => encodeSourceJson('a', 2), /bound/)
  assert.throws(() => parseSourceJson('"é"', 3), /bounded/)
  assert.throws(() => parseSourceJson('1e999', 5), /Invalid/)
  assert.throws(() => encodeSourceJson(Infinity, 100), /Non-finite/)
  assert.throws(() => parseSourceJson('null', undefined), /capacity/)
  assert.throws(() => encodeSourceJson(null, SOURCE_PLAN_BYTES + 1), /capacity/)
})

for (const [width, height] of [
  [8, 8],
  [128, 128],
  [129, 129],
  [1280, 1280],
]) {
  test(`complete ${width}×${height} source copies original chunks then explicitly releases`, async () => {
    const f = fixture(width, height)
    const receipt = await f.copy()
    assert.deepEqual(receipt, f.lease.receipt)
    assert.deepEqual(Buffer.from(f.destination), f.original)
    const reads = f.calls.filter((call) => call.operation === 'read_source')
    assert.equal(reads.length, Math.ceil(f.original.length / SOURCE_CHUNK_BYTES))
    assert.deepEqual(
      reads.map((call) => call.body.offset),
      reads.map((_call, i) => i * SOURCE_CHUNK_BYTES)
    )
    assert.equal(f.calls.at(-1).operation, 'release_source')
  })
}

for (const [name, change] of [
  [
    'foreign source',
    (f) => {
      f.source.cameraId = 'foreign'
    },
  ],
  [
    'wrong plan',
    (f) => {
      f.input.planSha256 = 'b'.repeat(64)
    },
  ],
  [
    'not due',
    (f) => {
      f.input.tick = 1
    },
  ],
  [
    'non-finite input',
    (f) => {
      f.input.drones[0].position[1] = Infinity
    },
  ],
]) {
  test(`${name} rejects before any private capture`, async () => {
    const f = fixture()
    change(f)
    await assert.rejects(f.copy(), SourceGraphicsTransferError)
    assert.equal(f.calls.length, 0)
  })
}

for (const [name, change] of [
  [
    'source',
    (value) => {
      value.receipt.cameraId = 'foreign'
    },
  ],
  [
    'tick',
    (value) => {
      value.receipt.tick++
    },
  ],
  [
    'input',
    (value) => {
      value.receipt.inputSha256 = 'b'.repeat(64)
    },
  ],
  [
    'extent',
    (value) => {
      value.receipt.byteLength++
    },
  ],
  [
    'encoding',
    (value) => {
      value.receipt.encoding = 'float32-le'
    },
  ],
  [
    'unknown field',
    (value) => {
      value.extra = true
    },
  ],
  [
    'stale sequence',
    (value) => {
      value.sequence = 2
    },
  ],
  [
    'malformed digest',
    (value) => {
      value.originalSha256 = 'A'.repeat(64)
    },
  ],
]) {
  test(`${name} receipt cannot authorize a chunk read or release`, async () => {
    const f = fixture()
    f.alter((operation, value) => {
      if (operation === 'capture_source') change(value)
      return value
    })
    await assert.rejects(f.copy(), SourceGraphicsTransferError)
    assert.deepEqual(
      f.calls.map((call) => call.operation),
      ['capture_source']
    )
  })
}

for (const [name, change] of [
  [
    'wrong offset',
    (value) => {
      value.offset++
    },
  ],
  [
    'wrong sequence',
    (value) => {
      value.sequence++
    },
  ],
  [
    'foreign original',
    (value) => {
      value.originalSha256 = 'c'.repeat(64)
    },
  ],
  [
    'truncated bytes',
    (value) => {
      value.bytesBase64 = value.bytesBase64.slice(4)
    },
  ],
  [
    'noncanonical base64',
    (value) => {
      value.bytesBase64 = '\n' + value.bytesBase64.slice(1)
    },
  ],
  [
    'chunk hash',
    (value) => {
      value.chunkSha256 = 'd'.repeat(64)
    },
  ],
  [
    'oversized output',
    (value) => {
      value.bytesBase64 = 'x'.repeat(65536)
    },
  ],
  [
    'unknown field',
    (value) => {
      value.untrusted = true
    },
  ],
]) {
  test(`${name} chunk rejects without source release`, async () => {
    const f = fixture()
    f.alter((operation, value) => {
      if (operation === 'read_source') change(value)
      return value
    })
    await assert.rejects(f.copy(), SourceGraphicsTransferError)
    assert.equal(
      f.calls.some((call) => call.operation === 'release_source'),
      false
    )
  })
}

test('rehashed altered chunk fails the complete original commitment', async () => {
  const f = fixture()
  f.alter((operation, value) => {
    if (operation === 'read_source' && value.offset === 0) {
      const bytes = Buffer.from(value.bytesBase64, 'base64')
      bytes[0] ^= 1
      value.bytesBase64 = bytes.toString('base64')
      value.chunkSha256 = sourceDigest(bytes)
    }
    return value
  })
  await assert.rejects(f.copy(), /Complete source original/)
  assert.equal(
    f.calls.some((call) => call.operation === 'release_source'),
    false
  )
})

test('unknown or altered release cannot produce a successful transfer', async () => {
  const f = fixture()
  f.alter((operation, value) =>
    operation === 'release_source' ? { ...value, released: false } : value
  )
  await assert.rejects(f.copy(), /release changed/)
  assert.deepEqual(Buffer.from(f.destination), f.original)
})

test('actual acquisition error remains separate from integrity and is not retried', async () => {
  const f = fixture()
  const error = new SourceGraphicsTransferError('acquisition', 'actual source failed', null)
  f.alter((operation, value) => {
    if (operation === 'capture_source') throw error
    return value
  })
  await assert.rejects(f.copy(), (value) => value === error)
  assert.equal(f.calls.length, 1)
})
