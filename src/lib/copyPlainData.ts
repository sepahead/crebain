/** Copy data descriptors once. Validation never reads caller-owned accessors. */
export function copyPlainData<T>(input: T): T {
  let nodes = 0
  const ancestors = new Set<object>()
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 8) throw new Error('Dynamics admission copy budget exceeded')
    if (typeof value === 'string') {
      if (value.length > 256) throw new Error('Dynamics admission string budget exceeded')
      return value
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (!value || typeof value !== 'object')
      throw new Error('Dynamics admission requires data values')
    const array = Array.isArray(value)
    if (
      Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) ||
      ancestors.has(value)
    ) {
      throw new Error('Dynamics admission requires acyclic plain data')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.getOwnPropertyNames(descriptors)
    if (Object.getOwnPropertySymbols(descriptors).length > 0)
      throw new Error('Dynamics admission rejects symbol properties')
    for (const descriptor of Object.values(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value'))
        throw new Error('Dynamics admission rejects accessors')
    }
    ancestors.add(value)
    try {
      if (array) {
        const length: unknown = descriptors.length?.value
        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 256
        ) {
          throw new Error('Unsupported dynamics array length')
        }
        if (keys.length !== length + 1)
          throw new Error('Dynamics admission requires dense arrays without extra properties')
        const result: unknown[] = []
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor?.enumerable)
            throw new Error('Dynamics admission requires dense enumerable arrays')
          result.push(copy(descriptor.value, depth + 1))
        }
        return Object.freeze(result)
      }
      if (keys.length > 16) throw new Error('Dynamics admission object budget exceeded')
      const entries = Object.entries(descriptors).map(([key, descriptor]): [string, unknown] => {
        if (!descriptor.enumerable) throw new Error('Dynamics admission rejects hidden properties')
        return [key, copy(descriptor.value, depth + 1)]
      })
      return Object.freeze(Object.fromEntries(entries))
    } finally {
      ancestors.delete(value)
    }
  }
  return copy(input, 0) as T
}
