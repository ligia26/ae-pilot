/** Rolls several analytics tenants (prod, eu/us, …) of one account into one usage summary. */
import { WEEKS } from "../data/analytics.ts";
import { daysBetween, pctChange } from "./format.ts";
import type { AlertHit, CustomerUsage, UsageSummary } from "./types.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function summariseUsage(tenants: CustomerUsage[], asOf: string): UsageSummary | null {
  if (tenants.length === 0) return null;

  const weekly = Array<number>(WEEKS).fill(0);
  const recent = new Set<string>();
  const prior = new Set<string>();
  const contracts: UsageSummary["contracts"] = [];
  const alerts: AlertHit[] = [];
  let last: string | null = null;
  let activeKeys = 0;
  let keysUsedLast14d = 0;

  for (const t of tenants) {
    t.weekly.requests.forEach((v, i) => (weekly[i] += v));
    t.agentsRecent.forEach((a) => recent.add(a));
    t.agentsPrior.forEach((a) => prior.add(a));
    if (t.lastEventDate && (!last || t.lastEventDate > last)) last = t.lastEventDate;
    activeKeys += t.activeKeys;
    keysUsedLast14d += t.keysUsedLast14d;
    alerts.push(...t.alerts);
    for (const c of t.contracts)
      contracts.push({
        ...c,
        pctRemaining: c.amount && c.balance != null ? Math.round((c.balance / c.amount) * 100) : null,
        daysToEnd: c.ending_before ? daysBetween(asOf, c.ending_before) : null,
      });
  }

  const req28 = Math.round(sum(weekly.slice(0, 4)));
  const reqPrior28 = Math.round(sum(weekly.slice(4, 8)));
  return {
    weeklyRequests: weekly.map(Math.round),
    req28,
    reqPrior28,
    changePct: pctChange(req28, reqPrior28),
    wowPct: pctChange(weekly[0], weekly[1]),
    lastEventDate: last,
    daysSinceUsage: last ? daysBetween(last, asOf) : null,
    agentsRecent: [...recent],
    agentsNew: [...recent].filter((a) => !prior.has(a)),
    agentsDropped: [...prior].filter((a) => !recent.has(a)),
    activeKeys,
    keysUsedLast14d,
    contracts,
    alerts,
  };
}
