// Shared display helpers — single source for the admin AND the dashboard
// (these were duplicated verbatim in both pages; the XSS escape especially
// must never drift between them).

export function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(3); }

// Operator-supplied strings (alphaTags, error messages) are rendered via
// innerHTML — escape to prevent stored XSS.
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
