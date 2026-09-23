/** Bounded advisory diagnostics. These records grant no execution or cleanup authority. */
const PREFIX = 'CREBAIN_FAMILY_FAILURE_V1 '
const MAX_BYTES = 4096
const MAX_NODES = 8
const MAX_EDGES = 8
const MAX_DEPTH = 4
const MAX_MESSAGE = 128

interface FailureNode {
  id: number
  kind: string
  message: string | null
  message_truncated: boolean
  inspection_failed: boolean
}
interface FailureEdge {
  from: number
  to: number | null
  relation: 'aggregate' | 'cause'
  index: number | null
}
interface OwnData {
  found: boolean
  value?: unknown
}

/** Inspect only bounded own data properties; never invoke an exception's getters or coercions. */
export function familyFailureLine(primary: unknown): Buffer {
  const fallback = () =>
    Buffer.from(
      `${PREFIX}{"schema":"crebain.family-failure.v1","authority":"advisory-only","summary_unavailable":true}\n`
    )
  try {
    const nodes: FailureNode[] = []
    const edges: FailureEdge[] = []
    const seen = new WeakMap<object, number>()
    const pending: {
      value: unknown
      reference: object | null
      node: FailureNode
      depth: number
    }[] = []
    let truncated = false
    const message = (value: string): string => {
      let result = ''
      for (let index = 0; index < Math.min(value.length, MAX_MESSAGE); index++) {
        const code = value.charCodeAt(index)
        result += code >= 32 && code <= 126 ? value[index] : '?'
      }
      return result
    }
    const admit = (value: unknown, depth: number): number | null => {
      const reference =
        value !== null && (typeof value === 'object' || typeof value === 'function') ? value : null
      const prior = reference === null ? undefined : seen.get(reference)
      if (prior !== undefined) return prior
      if (depth > MAX_DEPTH || nodes.length >= MAX_NODES) {
        truncated = true
        return null
      }
      const node: FailureNode = {
        id: nodes.length,
        kind: value === null ? 'null' : typeof value,
        message: null,
        message_truncated: false,
        inspection_failed: false,
      }
      nodes.push(node)
      if (reference !== null) seen.set(reference, node.id)
      pending.push({ value, reference, node, depth })
      return node.id
    }
    admit(primary, 0)
    // Breadth-first inspection retains immediate primary and cleanup members
    // before either member's nested causes can consume the remaining budget.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const { value, reference, node, depth } = pending[cursor]
      const own = (source: object, key: string): OwnData => {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(source, key)
          if (!descriptor) return { found: false }
          if (Object.hasOwn(descriptor, 'value')) return { found: true, value: descriptor.value }
        } catch {
          // Proxy traps are fallible. Their failures cannot replace the primary failure.
        }
        node.inspection_failed = true
        return { found: false }
      }
      const text = reference === null ? value : own(reference, 'message').value
      if (typeof text === 'string') {
        node.message = message(text)
        node.message_truncated = text.length > MAX_MESSAGE
        truncated ||= node.message_truncated
      }
      if (reference === null) continue
      const connect = (
        child: unknown,
        relation: FailureEdge['relation'],
        index: number | null
      ): boolean => {
        if (edges.length >= MAX_EDGES) {
          truncated = true
          return false
        }
        // Reserve the edge before admitting its child. All causes share one budget.
        const edge: FailureEdge = { from: node.id, to: null, relation, index }
        edges.push(edge)
        edge.to = admit(child, depth + 1)
        return true
      }
      const errors = own(reference, 'errors')
      if (errors.found) {
        let array = false
        try {
          array = Array.isArray(errors.value)
        } catch {
          node.inspection_failed = true
        }
        if (array) {
          const list = errors.value as unknown[]
          const length = own(list, 'length').value
          if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
            const extent = Math.min(length, MAX_EDGES)
            if (length > extent) truncated = true
            for (let index = 0; index < extent; index++) {
              if (edges.length >= MAX_EDGES) {
                truncated = true
                break
              }
              const member = own(list, String(index))
              if (member.found && !connect(member.value, 'aggregate', index)) break
            }
          } else node.inspection_failed = true
        } else node.inspection_failed = true
      }
      const cause = own(reference, 'cause')
      if (cause.found) connect(cause.value, 'cause', null)
    }
    const line = Buffer.from(
      `${PREFIX}${JSON.stringify({
        schema: 'crebain.family-failure.v1',
        authority: 'advisory-only',
        message_scope: 'own-data-ascii-prefix',
        root: 0,
        nodes,
        edges,
        truncated,
      })}\n`
    )
    return line.length <= MAX_BYTES ? line : fallback()
  } catch {
    return fallback()
  }
}

type DiagnosticWrite = (line: Buffer, done: (error?: Error | null) => void) => unknown

/** A failed or stalled diagnostic write never replaces the operation's failure. */
export async function reportFamilyFailure(
  primary: unknown,
  write: DiagnosticWrite = (line, done) => process.stderr.write(line, done)
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000)
      }),
      new Promise<boolean>((resolve) => {
        write(familyFailureLine(primary), (error) => resolve(!error))
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
