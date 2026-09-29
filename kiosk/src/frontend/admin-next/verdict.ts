// The verdict may not read calmer than the alert list: /api/system can say
// "healthy" while carrying an over-temperature alert (same rule as the
// classic admin's Now panel).
export type Verdict = "healthy" | "stressed" | "trouble";
export interface SystemAlert { id: string; severity: "attention" | "severe"; title: string; message: string; help: string }

const RANK: Record<Verdict, number> = { healthy: 0, stressed: 1, trouble: 2 };

export function worseVerdict(health: { verdict: Verdict; reason: string }, alerts: SystemAlert[]): { verdict: Verdict; text: string } {
  const fromAlerts: Verdict = alerts.some((a) => a.severity === "severe") ? "trouble" : alerts.length ? "stressed" : "healthy";
  if (RANK[fromAlerts] > RANK[health.verdict]) {
    const loudest = alerts.find((a) => a.severity === "severe") ?? alerts[0];
    return { verdict: fromAlerts, text: loudest?.title ?? health.reason };
  }
  return { verdict: health.verdict, text: health.reason };
}

/** What the top bar can show: a real verdict, or "unknown" when /api/system
 *  didn't answer — never a stale "healthy". */
export type Glance = Verdict | "unknown";
export const UNREACHABLE_TEXT = "Can't reach the radio";

export interface SystemGlance {
  health: { verdict: Verdict; reason: string };
  alerts: SystemAlert[];
  now?: { tempC?: number | null } | null;
}

/** The top-bar verdict line (spec §2: "<reason> · <temp>°C"), from one
 *  /api/system response, or the unknown state when there is none. */
export function glance(sys: SystemGlance | null): { verdict: Glance; text: string } {
  if (!sys) return { verdict: "unknown", text: UNREACHABLE_TEXT };
  const v = worseVerdict(sys.health, sys.alerts);
  const t = sys.now?.tempC;
  const reason = v.text.replace(/\.$/, "");
  return { verdict: v.verdict, text: typeof t === "number" && Number.isFinite(t) ? `${reason} · ${Math.round(t)}°C` : reason };
}
