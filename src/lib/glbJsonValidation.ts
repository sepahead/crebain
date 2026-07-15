const MAX_JSON_NESTING_DEPTH = 128
const MAX_JSON_OBJECT_KEYS = 100_000

class BoundedJsonDuplicateKeyScanner {
  private index = 0
  private objectKeyCount = 0

  constructor(private readonly json: string) {}

  scan(): void {
    this.parseValue(0)
    this.skipWhitespace()
    if (this.index !== this.json.length) this.failSyntax()
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_NESTING_DEPTH) {
      throw new Error(`GLB JSON exceeds the maximum nesting depth of ${MAX_JSON_NESTING_DEPTH}`)
    }

    this.skipWhitespace()
    const token = this.json[this.index]
    if (token === '{') {
      this.parseObject(depth)
      return
    }
    if (token === '[') {
      this.parseArray(depth)
      return
    }
    if (token === '"') {
      this.parseString(false)
      return
    }
    if (token === '-' || (token >= '0' && token <= '9')) {
      this.parseNumber()
      return
    }
    if (
      this.consumeLiteral('true') ||
      this.consumeLiteral('false') ||
      this.consumeLiteral('null')
    ) {
      return
    }
    this.failSyntax()
  }

  private parseObject(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.json[this.index] === '}') {
      this.index += 1
      return
    }

    const keys = new Set<string>()
    while (this.index < this.json.length) {
      this.skipWhitespace()
      if (this.json[this.index] !== '"') this.failSyntax()
      const key = this.parseString(true)
      this.objectKeyCount += 1
      if (this.objectKeyCount > MAX_JSON_OBJECT_KEYS) {
        throw new Error(`GLB JSON exceeds the maximum of ${MAX_JSON_OBJECT_KEYS} object keys`)
      }
      if (keys.has(key)) throw new Error('GLB JSON contains a duplicate object key')
      keys.add(key)

      this.skipWhitespace()
      if (this.json[this.index] !== ':') this.failSyntax()
      this.index += 1
      this.parseValue(depth + 1)
      this.skipWhitespace()

      const delimiter = this.json[this.index]
      if (delimiter === '}') {
        this.index += 1
        return
      }
      if (delimiter !== ',') this.failSyntax()
      this.index += 1
    }
    this.failSyntax()
  }

  private parseArray(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.json[this.index] === ']') {
      this.index += 1
      return
    }

    while (this.index < this.json.length) {
      this.parseValue(depth + 1)
      this.skipWhitespace()
      const delimiter = this.json[this.index]
      if (delimiter === ']') {
        this.index += 1
        return
      }
      if (delimiter !== ',') this.failSyntax()
      this.index += 1
    }
    this.failSyntax()
  }

  private parseString(decode: boolean): string {
    const start = this.index
    this.index += 1

    while (this.index < this.json.length) {
      const code = this.json.charCodeAt(this.index)
      if (code === 0x22) {
        this.index += 1
        if (!decode) return ''
        const parsed: unknown = JSON.parse(this.json.slice(start, this.index))
        if (typeof parsed !== 'string') this.failSyntax()
        return parsed
      }
      if (code < 0x20) this.failSyntax()
      if (code !== 0x5c) {
        this.index += 1
        continue
      }

      this.index += 1
      const escape = this.json[this.index]
      if (escape === 'u') {
        for (let offset = 1; offset <= 4; offset += 1) {
          const digit = this.json.charCodeAt(this.index + offset)
          const isHexDigit =
            (digit >= 0x30 && digit <= 0x39) ||
            (digit >= 0x41 && digit <= 0x46) ||
            (digit >= 0x61 && digit <= 0x66)
          if (!isHexDigit) this.failSyntax()
        }
        this.index += 5
      } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
        this.index += 1
      } else {
        this.failSyntax()
      }
    }
    this.failSyntax()
  }

  private parseNumber(): void {
    if (this.json[this.index] === '-') this.index += 1
    if (this.json[this.index] === '0') {
      this.index += 1
    } else {
      if (!this.isDigit(this.json[this.index], false)) this.failSyntax()
      while (this.isDigit(this.json[this.index], true)) this.index += 1
    }

    if (this.json[this.index] === '.') {
      this.index += 1
      if (!this.isDigit(this.json[this.index], true)) this.failSyntax()
      while (this.isDigit(this.json[this.index], true)) this.index += 1
    }

    if (this.json[this.index] === 'e' || this.json[this.index] === 'E') {
      this.index += 1
      if (this.json[this.index] === '+' || this.json[this.index] === '-') this.index += 1
      if (!this.isDigit(this.json[this.index], true)) this.failSyntax()
      while (this.isDigit(this.json[this.index], true)) this.index += 1
    }
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.json.startsWith(literal, this.index)) return false
    this.index += literal.length
    return true
  }

  private skipWhitespace(): void {
    while (
      this.json[this.index] === ' ' ||
      this.json[this.index] === '\n' ||
      this.json[this.index] === '\r' ||
      this.json[this.index] === '\t'
    ) {
      this.index += 1
    }
  }

  private isDigit(value: string | undefined, allowZero: boolean): boolean {
    return value !== undefined && value >= (allowZero ? '0' : '1') && value <= '9'
  }

  private failSyntax(): never {
    throw new Error('GLB JSON chunk is invalid UTF-8 or JSON')
  }
}

export function validateGlbJsonSyntax(json: string): void {
  new BoundedJsonDuplicateKeyScanner(json).scan()
}
