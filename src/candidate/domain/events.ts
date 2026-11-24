/**
 * What happened in the last N days, across CRM and product usage.
 * Routine emails are counted, not listed — the AE (and the model) only see
 * what stands out: meetings, notes, stage changes, alerts, unanswered inbound
 * emails and big week-over-week usage moves.
 */
import { daysBetween, day, signed } from "./format.ts";
import type { AccountView } from "./types.ts";

export type Event = { date: string; accountId: string; accountName: string; source: "crm" | "analytics"; what: string };
export type EventSummary = { days: number; counts: Record<string, number>; notable: Event[] };

const within = (iso: string, asOf: string, days: number) => { const d = daysBetween(iso, asOf); return d >= 0 && d <= days; };

export function summariseEvents(views: AccountView[], asOf: string, days = 7): EventSummary {
  const counts: Record<string, number> = {};
  const notable: Event[] = [];
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const v of views) {
    const base = { accountId: v.account.id, accountName: v.account.name };
    for (const a of v.activities) {
      if (!within(a.timestamp, asOf, days)) continue;
      const date = day(a.timestamp);
      if (a.type === "email") bump(`${a.direction} emails`);
      if (a.type === "meeting") { bump("meetings"); notable.push({ ...base, date, source: "crm", what: `meeting${a.outcome ? ` (${a.outcome})` : ""}` }); }
      if (a.type === "stage_change") { bump("stage changes"); notable.push({ ...base, date, source: "crm", what: `stage ${a.from ?? "?"} -> ${a.to}` }); }
      if (a.type === "note") { bump("notes"); notable.push({ ...base, date, source: "crm", what: `note: "${a.text}"` }); }
    }
    for (const al of v.usage?.alerts ?? [])
      if (within(al.createdAt, asOf, days)) { bump("usage alerts"); notable.push({ ...base, date: day(al.createdAt), source: "analytics", what: `alert: ${al.alert}` }); }

    // Unanswered inbound emails received inside the window, dated by the email itself.
    const lastInbound = v.activities.find((a) => a.type === "email" && a.direction === "inbound");
    if (lastInbound && within(lastInbound.timestamp, asOf, days) && v.signals.some((s) => s.id === "awaiting_reply")) {
      bump("inbound emails still awaiting reply");
      notable.push({ ...base, date: day(lastInbound.timestamp), source: "crm", what: `inbound email awaiting reply ("${lastInbound.type === "email" ? lastInbound.subject ?? "" : ""}")` });
    }

    const u = v.usage;
    if (u && u.wowPct != null && u.weeklyRequests[1] >= 100 && Math.abs(u.wowPct) >= 30) {
      bump("big week-over-week usage moves");
      notable.push({ ...base, date: asOf, source: "analytics", what: `requests ${signed(u.wowPct)} week over week (${u.weeklyRequests[0]} vs ${u.weeklyRequests[1]})` });
    }
  }
  // Meetings, notes, stage changes, alerts and usage moves before the (many) unanswered emails; newest first within each.
  const rank = (e: Event) => (e.what.startsWith("inbound email awaiting") ? 1 : 0);
  notable.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
  return { days, counts, notable };
}
