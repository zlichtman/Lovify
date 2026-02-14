import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; fallbackTab?: string };
type State = { hasError: boolean; error: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: "" };

  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, error: err instanceof Error ? err.message : String(err) };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="feature-section">
          <div className="error" style={{ textAlign: "center", padding: "2rem 1rem" }}>
            <p style={{ marginBottom: "0.5rem" }}>Something went wrong{this.props.fallbackTab ? ` in ${this.props.fallbackTab}` : ""}.</p>
            <p style={{ fontSize: "0.8rem", opacity: 0.7, marginBottom: "1rem" }}>{this.state.error}</p>
            <button
              type="button"
              className="primary small-btn"
              onClick={() => this.setState({ hasError: false, error: "" })}
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
