/**
 * High-performance circular buffer implementation
 * O(1) push, O(1) indexed access, O(1) iteration setup
 *
 * Used for position history tracking where frequent push + shift
 * would cause O(n) overhead with standard arrays.
 */

export class CircularBuffer<T> {
  static readonly MAX_CAPACITY = 1_000_000
  private buffer: (T | undefined)[]
  private head: number = 0 // Next write position
  private count: number = 0
  private readonly capacity: number

  constructor(capacity: number) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      capacity > CircularBuffer.MAX_CAPACITY
    ) {
      throw new RangeError(
        `CircularBuffer capacity must be a positive safe integer no greater than ${CircularBuffer.MAX_CAPACITY}`
      )
    }
    this.capacity = capacity
    this.buffer = new Array<T | undefined>(capacity)
  }

  /**
   * Add item to buffer, overwriting oldest if full
   * O(1) complexity
   */
  push(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  /**
   * Get item by index (0 = oldest, length-1 = newest)
   * O(1) complexity
   */
  get(index: number): T | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) {
      return undefined
    }
    // Calculate actual position: start from tail (oldest) and offset by index
    const tail =
      this.count === this.capacity
        ? this.head // When full, head points to oldest
        : 0 // When not full, oldest is at 0
    const actualIndex = (tail + index) % this.capacity
    return this.buffer[actualIndex]
  }

  /**
   * Get the most recent item
   * O(1) complexity
   */
  newest(): T | undefined {
    if (this.count === 0) return undefined
    const newestIndex = (this.head - 1 + this.capacity) % this.capacity
    return this.buffer[newestIndex]
  }

  /**
   * Get the oldest item
   * O(1) complexity
   */
  oldest(): T | undefined {
    if (this.count === 0) return undefined
    return this.get(0)
  }

  /**
   * Get last N items (newest first)
   * O(n) where n is count parameter
   */
  lastN(n: number): T[] {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError('CircularBuffer lastN count must be a non-negative safe integer')
    }
    const result: T[] = []
    const actualN = Math.min(n, this.count)
    for (let i = this.count - 1; i >= this.count - actualN; i--) {
      const item = this.get(i)
      if (item !== undefined) {
        result.push(item)
      }
    }
    return result
  }

  /**
   * Convert to array (oldest to newest order)
   * O(n) complexity - use sparingly
   */
  toArray(): T[] {
    const result: T[] = []
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined) {
        result.push(item)
      }
    }
    return result
  }

  /**
   * Current number of items in buffer
   */
  get length(): number {
    return this.count
  }

  /**
   * Maximum capacity of buffer
   */
  get size(): number {
    return this.capacity
  }

  /**
   * Check if buffer is full
   */
  isFull(): boolean {
    return this.count === this.capacity
  }

  /**
   * Check if buffer is empty
   */
  isEmpty(): boolean {
    return this.count === 0
  }

  /**
   * Clear all items
   * O(capacity) complexity so removed objects are immediately eligible for garbage collection.
   */
  clear(): void {
    this.head = 0
    this.count = 0
    this.buffer.fill(undefined)
  }

  /**
   * Iterate over items (oldest to newest)
   * Supports for...of loops
   */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined) {
        yield item
      }
    }
  }

  /**
   * forEach iteration (oldest to newest)
   */
  forEach(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined) {
        callback(item, i)
      }
    }
  }

  /**
   * Map to new array
   */
  map<U>(callback: (item: T, index: number) => U): U[] {
    const result: U[] = []
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined) {
        result.push(callback(item, i))
      }
    }
    return result
  }

  /**
   * Find item matching predicate
   */
  find(predicate: (item: T, index: number) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined && predicate(item, i)) {
        return item
      }
    }
    return undefined
  }

  /**
   * Filter items matching predicate
   */
  filter(predicate: (item: T, index: number) => boolean): T[] {
    const result: T[] = []
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined && predicate(item, i)) {
        result.push(item)
      }
    }
    return result
  }

  /**
   * Reduce buffer to single value
   */
  reduce<U>(callback: (acc: U, item: T, index: number) => U, initial: U): U {
    let acc = initial
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i)
      if (item !== undefined) {
        acc = callback(acc, item, i)
      }
    }
    return acc
  }
}

/**
 * Create a CircularBuffer with initial items
 */
export function createCircularBuffer<T>(capacity: number, items?: T[]): CircularBuffer<T> {
  const buffer = new CircularBuffer<T>(capacity)
  if (items) {
    for (const item of items) {
      buffer.push(item)
    }
  }
  return buffer
}
