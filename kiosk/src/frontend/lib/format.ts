// Shared display helpers — single source for the admin AND the dashboard
// (these were duplicated verbatim in both pages; the XSS escape especially
// must never drift between them).

// Four decimals, always: scanner frequencies live on a 12.5 kHz raster, and
// three decimals literally misrepresents them (462.8875 -> "462.888").
export function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(4); }

// Operator-supplied strings (alphaTags, error messages) are rendered via
// innerHTML — escape to prevent stored XSS.
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
