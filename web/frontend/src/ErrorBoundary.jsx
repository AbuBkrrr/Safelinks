import React from "react";

/* Without this, any uncaught render error anywhere in the tree — a bad
 * prop, an undefined property access, whatever — unmounts the ENTIRE
 * app and leaves a blank white page with no indication anything went
 * wrong (React logs to the console, but nothing on screen does). That
 * makes every bug maximally confusing to report and debug. This
 * catches it at the top level, shows something a person can actually
 * screenshot and describe, and — critically — logs the real error and
 * component stack to the console so it's diagnosable from a bug
 * report instead of a guess. */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("SAFE_Links crashed:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        maxWidth: 560, margin: "60px auto", padding: 24, fontFamily: "system-ui, sans-serif",
        background: "#fff", border: "1px solid #f0c0c0", borderRadius: 12, color: "#2a2a3a",
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something went wrong on this screen</div>
        <div style={{ fontSize: 13.5, color: "#666", marginBottom: 14, lineHeight: 1.6 }}>
          This page hit an error and couldn't finish loading. Reloading usually fixes it. If it keeps
          happening, the details below are worth including in a bug report.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "9px 16px", borderRadius: 8, border: "none", background: "#667eea",
            color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13.5, marginBottom: 14,
          }}
        >
          Reload
        </button>
        <details style={{ fontSize: 12, color: "#888" }}>
          <summary style={{ cursor: "pointer" }}>Error details</summary>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{String(this.state.error?.stack || this.state.error)}</pre>
        </details>
      </div>
    );
  }
}
