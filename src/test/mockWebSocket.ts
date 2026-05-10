export class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1

  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closeCalls = 0
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closeCalls += 1
    this.readyState = 3
    this.onclose?.(new Event('close'))
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  error(type = 'error') {
    this.onerror?.(new Event(type))
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  static reset() {
    MockWebSocket.instances = []
  }

  static last() {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    if (!ws) throw new Error('Expected WebSocket instance')
    return ws
  }
}

export function installMockWebSocket() {
  const originalWebSocket = globalThis.WebSocket
  MockWebSocket.reset()
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  })
  return () => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    })
  }
}

export function sentMessages(ws: MockWebSocket) {
  return ws.sent.map((data) => JSON.parse(data) as Record<string, unknown>)
}
