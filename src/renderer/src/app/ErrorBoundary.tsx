import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Last line of defence: a rendering bug shows a way out instead of a blank window. The buffer keeps running in main. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-base font-semibold">Something went wrong</h1>
        <p className="max-w-md text-xs leading-relaxed text-muted">
          The replay buffer is still running and your clips are safe. Reloading usually fixes this.
        </p>
        <pre className="max-h-40 max-w-xl overflow-auto rounded-lg border border-line bg-surface p-3 text-left text-2xs text-faint select-text">
          {this.state.error.message}
        </pre>
        <button
          className="h-8 rounded-md bg-accent px-4 text-xs font-medium text-white hover:bg-accent-hover"
          onClick={() => location.reload()}
        >
          Reload Podium
        </button>
      </div>
    )
  }
}
