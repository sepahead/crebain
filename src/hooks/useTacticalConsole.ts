/**
 * CREBAIN Tactical Console Hook
 * Centralized messaging system for operator feedback
 */

import { useState, useCallback, useRef, useEffect } from 'react'

export type MessageLevel = 'info' | 'success' | 'warning' | 'error' | 'tactical' | 'system'

export interface TacticalMessage {
  id: string
  level: MessageLevel
  text: string
  timestamp: number
  code?: string
}

export interface TacticalError {
  severity: 'info' | 'warning' | 'error'
  code?: string
  message: string
  context?: Record<string, unknown>
}

export interface UseTacticalConsoleConfig {
  maxMessages?: number
  defaultTimeoutMs?: number
  dedupeWindowMs?: number
}

export interface UseTacticalConsoleReturn {
  messages: TacticalMessage[]
  addMessage: (level: MessageLevel, text: string, code?: string) => void
  addError: (error: TacticalError) => void
  clearMessages: () => void
  clearMessage: (id: string) => void
}

const DEFAULT_CONFIG: Required<UseTacticalConsoleConfig> = {
  maxMessages: 50,
  defaultTimeoutMs: 5000,
  dedupeWindowMs: 1000,
}

export function useTacticalConsole(
  config: UseTacticalConsoleConfig = {}
): UseTacticalConsoleReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }

  const [messages, setMessages] = useState<TacticalMessage[]>([])
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const recentMessagesRef = useRef<Map<string, number>>(new Map())
  const messageIdRef = useRef(0)

  useEffect(() => {
    const timeouts = timeoutsRef.current
    const recent = recentMessagesRef.current
    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout))
      timeouts.clear()
      recent.clear()
    }
  }, [])

  const clearMessage = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id)
    if (timeout) {
      clearTimeout(timeout)
      timeoutsRef.current.delete(id)
    }
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const addMessage = useCallback(
    (level: MessageLevel, text: string, code?: string) => {
      const now = Date.now()
      const dedupeKey = `${level}:${text}`

      const lastSeen = recentMessagesRef.current.get(dedupeKey)
      if (lastSeen && now - lastSeen < mergedConfig.dedupeWindowMs) {
        return
      }
      recentMessagesRef.current.set(dedupeKey, now)

      // Evict stale dedupe entries so this map cannot grow unbounded over a long
      // session (each distinct level:text would otherwise persist forever).
      for (const [key, seen] of recentMessagesRef.current) {
        if (now - seen >= mergedConfig.dedupeWindowMs) {
          recentMessagesRef.current.delete(key)
        }
      }

      const id = `msg-${++messageIdRef.current}-${now}`
      const message: TacticalMessage = {
        id,
        level,
        text,
        timestamp: now,
        code,
      }

      setMessages((prev) => {
        const updated = [message, ...prev]
        if (updated.length > mergedConfig.maxMessages) {
          const removed = updated.slice(mergedConfig.maxMessages)
          removed.forEach((m) => {
            const timeout = timeoutsRef.current.get(m.id)
            if (timeout) {
              clearTimeout(timeout)
              timeoutsRef.current.delete(m.id)
            }
          })
          return updated.slice(0, mergedConfig.maxMessages)
        }
        return updated
      })

      const timeout = setTimeout(() => {
        clearMessage(id)
      }, mergedConfig.defaultTimeoutMs)
      timeoutsRef.current.set(id, timeout)
    },
    [
      mergedConfig.maxMessages,
      mergedConfig.defaultTimeoutMs,
      mergedConfig.dedupeWindowMs,
      clearMessage,
    ]
  )

  const addError = useCallback(
    (error: TacticalError) => {
      const level: MessageLevel =
        error.severity === 'info' ? 'info' : error.severity === 'warning' ? 'warning' : 'error'
      addMessage(level, error.message, error.code)
    },
    [addMessage]
  )

  const clearMessages = useCallback(() => {
    timeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
    timeoutsRef.current.clear()
    setMessages([])
  }, [])

  return {
    messages,
    addMessage,
    addError,
    clearMessages,
    clearMessage,
  }
}

export default useTacticalConsole
