/**
 * CREBAIN Error Boundary
 * Adaptive Response & Awareness System (ARAS)
 *
 * Catches and displays React component errors gracefully
 */

import { Component, type ReactNode, type ErrorInfo } from 'react'
import { logger } from '../lib/logger'

const log = logger.scope('ErrorBoundary')

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    try {
      this.props.onError?.(error, errorInfo)
    } catch (observerError) {
      log.warn('Error-boundary observer failed', { error: observerError })
    }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0a0a0a',
            color: '#ff4444',
            fontFamily: 'monospace',
            padding: '2rem',
          }}
        >
          <div style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>SYSTEM FEHLER</div>
          <div
            style={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              padding: '1rem',
              maxWidth: '600px',
              overflow: 'auto',
              marginBottom: '1rem',
            }}
          >
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {this.state.error?.message || 'Unknown error'}
            </pre>
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              backgroundColor: '#333',
              color: '#fff',
              border: '1px solid #555',
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              fontFamily: 'monospace',
            }}
          >
            NEUSTART
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
