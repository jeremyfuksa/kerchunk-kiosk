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
