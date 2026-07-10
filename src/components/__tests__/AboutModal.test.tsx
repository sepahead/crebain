import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@tauri-apps/api/app', () => ({ getVersion: tauriMocks.getVersion }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: tauriMocks.isTauri }))
vi.mock('../../lib/logger', () => ({
  logger: { scope: () => ({ error: vi.fn() }) },
}))

import { AboutModal } from '../AboutModal'

describe('AboutModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    tauriMocks.isTauri.mockReturnValue(false)
    tauriMocks.getVersion.mockResolvedValue('9.9.9')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('uses dialog semantics, traps focus, closes on Escape, and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()

    await act(async () => {
      root.render(<AboutModal isOpen={true} onClose={onClose} />)
    })

    const dialog = container.querySelector('[role="dialog"]')
    const close = container.querySelector<HTMLButtonElement>('button[aria-label]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(close)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(close)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(<AboutModal isOpen={false} onClose={onClose} />)
    })
    expect(document.activeElement).toBe(opener)
    expect(tauriMocks.getVersion).not.toHaveBeenCalled()
    opener.remove()
  })
})
