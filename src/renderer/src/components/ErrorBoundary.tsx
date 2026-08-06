import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

/** 错误边界：子组件渲染异常时显示错误信息，避免整个应用白屏 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // 转发到主进程终端，便于排查
    console.error('[ErrorBoundary]', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="empty-state">
          <h4 className="empty-state__title">内容渲染失败</h4>
          <p className="empty-state__hint" style={{ color: '#dc2626', wordBreak: 'break-all' }}>
            {this.state.error.message || String(this.state.error)}
          </p>
        </div>
      )
    }
    return this.props.children
  }
}
