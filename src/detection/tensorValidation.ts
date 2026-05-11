export function assertFloat32Tensor(data: unknown, context: string): Float32Array {
  if (!(data instanceof Float32Array)) {
    throw new Error(`${context}: output tensor data must be Float32Array`)
  }
  return data
}

export function assertDims(dims: readonly number[], rank: number, context: string): void {
  if (dims.length !== rank) {
    throw new Error(`${context}: expected rank ${rank}, got ${dims.length}`)
  }
  for (const [index, dim] of dims.entries()) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`${context}: dimension ${index} must be a positive integer`)
    }
  }
}

export function assertTensorLength(data: Float32Array, expectedLength: number, context: string): void {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) {
    throw new Error(`${context}: expected tensor length must be positive`)
  }
  if (data.length !== expectedLength) {
    throw new Error(`${context}: tensor length ${data.length} does not match expected ${expectedLength}`)
  }
}

export function assertFiniteTensorValues(data: Float32Array, context: string): void {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`${context}: tensor value ${i} must be finite`)
    }
  }
}

export function validateRank3Tensor(data: unknown, dims: readonly number[], context: string): Float32Array {
  const tensorData = assertFloat32Tensor(data, context)
  assertDims(dims, 3, context)
  assertTensorLength(tensorData, dims[0] * dims[1] * dims[2], context)
  assertFiniteTensorValues(tensorData, context)
  return tensorData
}

export function validateRank2Tensor(data: unknown, dims: readonly number[], context: string): Float32Array {
  const tensorData = assertFloat32Tensor(data, context)
  assertDims(dims, 2, context)
  assertTensorLength(tensorData, dims[0] * dims[1], context)
  assertFiniteTensorValues(tensorData, context)
  return tensorData
}
