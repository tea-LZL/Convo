import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary — catches render errors in its subtree and shows a
 * fallback card instead of crashing the whole app. Place it around
 * route content and high-risk components (streaming, chat).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ":" + this.props.label : ""}]`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="w-12 h-12 rounded-xl bg-error/10 border border-error/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-error text-xl">!</span>
            </div>
            <h2 className="text-sm font-semibold text-text mb-1">Something went wrong</h2>
            <p className="text-xs text-text-muted mb-4">
              {this.props.label ? `[${this.props.label}] ` : ""}
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 hover:bg-surface-3 border border-border rounded-md text-xs text-text transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}