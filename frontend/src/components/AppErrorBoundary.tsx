import React from 'react'

interface AppErrorBoundaryState {
  error: Error | null
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: asError(error) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[renderer] Unhandled application error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <main
        style={{
          minHeight: '100vh',
          boxSizing: 'border-box',
          display: 'grid',
          placeItems: 'center',
          padding: 32,
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <section style={{ width: 'min(680px, 100%)', padding: 28, borderRadius: 16, background: '#fff', boxShadow: '0 12px 36px rgba(15, 23, 42, 0.12)' }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>应用界面加载失败</h1>
          <p style={{ margin: '12px 0 0', color: '#475569', lineHeight: 1.6 }}>
            程序已拦截到渲染异常，因此不会再显示空白窗口。请重试；若仍失败，可将下方错误信息提供给开发者。
          </p>
          <p style={{ margin: '6px 0 0', color: '#64748b', lineHeight: 1.5 }}>
            The renderer failed to load. Retry, or share the error details below.
          </p>
          <pre style={{ margin: '18px 0', padding: 14, overflow: 'auto', borderRadius: 10, background: '#f1f5f9', color: '#b91c1c', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {error.stack || error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ border: 0, borderRadius: 9, padding: '10px 18px', background: '#00aeec', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
          >
            重新加载 / Reload
          </button>
        </section>
      </main>
    )
  }
}
