// Hash routes for the admin. The new admin answers at /admin; `#/next/…`
// from before the flip redirects (see legacyRedirect).
export type Tab = "radio" | "tune" | "library" | "system";

export const TAB_TITLES: Record<Tab, string> = {
  radio: "Radio", tune: "Tune", library: "Library", system: "System",
};

function segments(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

/** What the Library's detail sheet shows: a channel by id, the first channel
 *  on a frequency (Radio's "Recently heard" links), or a new channel — blank,
 *  pre-filled from a discovery, or pre-tagged for a bank. */
export type Detail =
  | { kind: "ch"; id: string }
  | { kind: "hz"; hz: number }
  | { kind: "add"; from?: string; tag?: string };

export interface Route { tab: Tab; sub?: "new"; detail?: Detail }

function decode(s: string | undefined): string | null {
  if (!s) return null;
  try { return decodeURIComponent(s); } catch { return null; }
}

function parseDetail(rest: string[]): Detail | null {
  const [kind, a, b] = rest;
  if (kind === "ch") { const id = decode(a); return id ? { kind: "ch", id } : null; }
  if (kind === "hz") {
    const hz = Number(a);
    return Number.isInteger(hz) && hz > 0 ? { kind: "hz", hz } : null;
  }
  if (kind === "add") {
    if (a === "from") { const from = decode(b); return from ? { kind: "add", from } : { kind: "add" }; }
    if (a === "tag") { const tag = decode(b); return tag ? { kind: "add", tag } : { kind: "add" }; }
    return { kind: "add" };
  }
  return null;
}

export function parseRoute(hash: string): Route {
  const [head, ...rest] = segments(hash);
  switch (head) {
    case "tune": return { tab: "tune" };
    case "library": {
      if (rest[0] === "new") return { tab: "library", sub: "new" };
      const detail = parseDetail(rest);
      return detail ? { tab: "library", detail } : { tab: "library" };
    }
    case "system": return { tab: "system" };
    default: return { tab: "radio" };
  }
}

function detailPath(d: Detail): string[] {
  switch (d.kind) {
    case "ch": return ["ch", encodeURIComponent(d.id)];
    case "hz": return ["hz", String(d.hz)];
    case "add":
      return d.from ? ["add", "from", encodeURIComponent(d.from)]
        : d.tag ? ["add", "tag", encodeURIComponent(d.tag)] : ["add"];
  }
}

export function hrefFor(r: Route): string {
  const path = [
    r.tab === "radio" ? "" : r.tab, r.sub ?? "", ...(r.detail ? detailPath(r.detail) : []),
  ].filter(Boolean).join("/");
  return `#/${path}`;
}

/** Classic-admin pages → the tab that does their job now. */
const LEGACY: Record<string, Route> = {
  home: { tab: "radio" },
  triage: { tab: "library", sub: "new" },
  channels: { tab: "library" },
  banks: { tab: "library" },
  scan: { tab: "tune" },
};

/** Where an old bookmark should go, or null when the hash is a current
 *  route. Two eras: the classic admin's pages, and the new admin's
 *  pre-flip home under `#/next/…` (path kept verbatim, still encoded). */
export function legacyRedirect(hash: string): string | null {
  const path = hash.replace(/^#\/?/, "");
  if (path === "next" || path.startsWith("next/")) return `#/${path.replace(/^next\/?/, "")}`;
  const to = LEGACY[path.split("/")[0] ?? ""];
  return to ? hrefFor(to) : null;
}

/** Chained bookmarks (e.g. a pre-flip `#/next/triage` link) redirect through
 *  more than one era: `#/next/triage` → `#/triage` → `#/library/new`.
 *  Resolves the whole chain to its final destination in one hop, bounded so
 *  a cycle can't loop forever. Returns null when the hash needs no redirect
 *  at all. */
export function resolveLegacy(hash: string, maxSteps = 3): string | null {
  let current = hash;
  let resolved: string | null = null;
  for (let i = 0; i < maxSteps; i++) {
    const next = legacyRedirect(current);
    if (!next) break;
    resolved = next;
    current = next;
  }
  return resolved;
}
