import { describe, expect, it, vi } from 'vitest'
import {
  DOCKED_PANEL_LAYOUT_MIN_SCALE,
  FREE_PANEL_LAYOUT_MIN_HEIGHT,
  FREE_PANEL_LAYOUT_MIN_WIDTH,
  MAGNIFIED_UI_MIN_SCALE,
  UI_SCALE_CONFIG,
  clampScale,
  readStoredScale,
  usesDockedPanelLayout,
  usesMagnifiedUiLayout,
  writeStoredScale,
} from '../uiScale'

function storageWith(value: string | null) {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  }
}

describe('UI scale storage', () => {
  it('selects the non-overlapping panel layout under scale or viewport pressure', () => {
    expect(
      usesDockedPanelLayout(
        DOCKED_PANEL_LAYOUT_MIN_SCALE - 0.1,
        FREE_PANEL_LAYOUT_MIN_WIDTH,
        FREE_PANEL_LAYOUT_MIN_HEIGHT
      )
    ).toBe(false)
    expect(
      usesDockedPanelLayout(
        DOCKED_PANEL_LAYOUT_MIN_SCALE,
        FREE_PANEL_LAYOUT_MIN_WIDTH,
        FREE_PANEL_LAYOUT_MIN_HEIGHT
      )
    ).toBe(true)
    expect(
      usesDockedPanelLayout(
        UI_SCALE_CONFIG.DEFAULT,
        FREE_PANEL_LAYOUT_MIN_WIDTH - 1,
        FREE_PANEL_LAYOUT_MIN_HEIGHT
      )
    ).toBe(true)
    expect(
      usesDockedPanelLayout(
        UI_SCALE_CONFIG.DEFAULT,
        FREE_PANEL_LAYOUT_MIN_WIDTH,
        FREE_PANEL_LAYOUT_MIN_HEIGHT - 1
      )
    ).toBe(true)
    expect(
      usesDockedPanelLayout(Number.NaN, FREE_PANEL_LAYOUT_MIN_WIDTH, FREE_PANEL_LAYOUT_MIN_HEIGHT)
    ).toBe(true)
  })

  it('selects magnified chrome only at the text-enlargement boundary', () => {
    expect(usesMagnifiedUiLayout(MAGNIFIED_UI_MIN_SCALE - 0.1)).toBe(false)
    expect(usesMagnifiedUiLayout(MAGNIFIED_UI_MIN_SCALE)).toBe(true)
    expect(usesMagnifiedUiLayout(Number.NaN)).toBe(false)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'uses the default for a non-finite direct scale: %s',
    (value) => {
      expect(clampScale(value)).toBe(UI_SCALE_CONFIG.DEFAULT)
    }
  )

  it('reads and clamps a finite persisted scale', () => {
    expect(readStoredScale(() => storageWith('1.25'))).toBe(1.25)
    expect(readStoredScale(() => storageWith('99'))).toBe(UI_SCALE_CONFIG.MAX)
  })

  it.each([null, '', ' ', 'Infinity', 'NaN', '1.2px'])(
    'rejects a missing or malformed persisted value: %s',
    (value) => {
      expect(readStoredScale(() => storageWith(value))).toBeNull()
    }
  )

  it('fails safely when the storage getter or read is denied', () => {
    const getterError = new DOMException('denied', 'SecurityError')
    const readError = new DOMException('denied', 'SecurityError')
    const onError = vi.fn()

    expect(
      readStoredScale(() => {
        throw getterError
      }, onError)
    ).toBeNull()
    expect(
      readStoredScale(
        () => ({
          getItem: () => {
            throw readError
          },
          setItem: vi.fn(),
        }),
        onError
      )
    ).toBeNull()
    expect(onError).toHaveBeenNthCalledWith(1, getterError)
    expect(onError).toHaveBeenNthCalledWith(2, readError)
  })

  it('writes a canonical, bounded scale', () => {
    const storage = storageWith(null)

    expect(writeStoredScale(() => storage, 99)).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(
      UI_SCALE_CONFIG.STORAGE_KEY,
      UI_SCALE_CONFIG.MAX.toString()
    )
  })

  it('fails safely when storage rejects a write', () => {
    const error = new DOMException('quota exceeded', 'QuotaExceededError')
    const onError = vi.fn()

    expect(
      writeStoredScale(
        () => ({
          getItem: vi.fn(),
          setItem: () => {
            throw error
          },
        }),
        1.2,
        onError
      )
    ).toBe(false)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('rejects a non-finite write without touching storage', () => {
    const storage = storageWith(null)
    const onError = vi.fn()

    expect(writeStoredScale(() => storage, Number.NaN, onError)).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError))
  })
})
