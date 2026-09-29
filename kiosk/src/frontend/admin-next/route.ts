// Hash routes for admin-next. While the classic admin is still the default
// the new tree lives under #/next; the flip PR sets NEXT_PREFIX to "".
export type Tab = "radio" | "tune" | "library" | "system";
export interface Route { tab: Tab; sub?: "new" }

export const NEXT_PREFIX: string = "next";

export const TAB_TITLES: Record<Tab, string> = {
  radio: "Radio", tune: "Tune", library: "Library", system: "System",
};

function segments(hash: string): string[] {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (NEXT_PREFIX && parts[0] === NEXT_PREFIX) parts.shift();
  return parts;
}

export function parseRoute(hash: string): Route {
  const [head, sub] = segments(hash);
  switch (head) {
    case "tune": return { tab: "tune" };
    case "library": return sub === "new" ? { tab: "library", sub: "new" } : { tab: "library" };
    case "system": return { tab: "system" };
    default: return { tab: "radio" };
  }
}

export function hrefFor(r: Route): string {
  const path = [NEXT_PREFIX, r.tab === "radio" ? "" : r.tab, r.sub ?? ""].filter(Boolean).join("/");
  return `#/${path}`;
}

/** Classic-admin bookmarks → the new tab. null = nothing to redirect. */
const LEGACY: Record<string, Route> = {
  triage: { tab: "library", sub: "new" },
  channels: { tab: "library" },
  banks: { tab: "library" },
  scan: { tab: "tune" },
};
export function legacyRedirect(hash: string): string | null {
  const head = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  const to = LEGACY[head];
  return to ? hrefFor(to) : null;
}
