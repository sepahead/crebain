import React, { useEffect, useId, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { logger } from '../lib/logger'

const log = logger.scope('App')

interface AboutModalProps {
  isOpen: boolean
  onClose: () => void
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const [appVersion, setAppVersion] = useState<string>('0.4.0') // Fallback/Dev version
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version)
      })
      .catch((err) => {
        if (!cancelled) log.error('Failed to get app version', { error: err })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="bg-[#1a1a1a] border border-[#333] rounded-lg p-8 max-w-md w-full shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Über CREBAIN schließen"
          className="absolute top-4 right-4 min-h-10 min-w-10 text-[#888] hover:text-white motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          ✕
        </button>

        <div className="flex flex-col items-center text-center">
          <img src="/crebain.png" alt="Crebain Logo" className="w-24 h-24 mb-6" />

          <h2 id={titleId} className="text-2xl font-bold text-white tracking-wider mb-2">
            CREBAIN
          </h2>
          <p className="text-[#888] text-sm tracking-widest uppercase mb-6">
            Adaptive Response & Awareness System
          </p>

          <div className="space-y-2 text-[#ccc] text-sm mb-8">
            <p>Version {appVersion}</p>
            <p id={descriptionId} className="pt-2 text-[#888]">
              Research-oriented tactical visualization prototype with 3D Gaussian Splatting support
              and multi-modal sensor fusion.
            </p>
          </div>

          <div className="text-xs text-[#444]">
            <p>© 2026 Gitjo. All rights reserved.</p>
            <p className="mt-1">Built with Tauri 2 & React 19</p>
          </div>
        </div>
      </div>
    </div>
  )
}
