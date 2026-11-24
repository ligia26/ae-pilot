/**
 * Signal rules. Each rule is a small pure function over one account's facts that
 * returns zero or more explainable signals (label + evidence with numbers + source).
 * Weights are hand-set and visible here; adding a signal = adding one rule.
 */
import { ACTIVE_STAGES, daysBetween, day, int, isOpen, money, signed } from "./format.ts";
import type { AccountFacts, Activity, Signal } from "./types.ts";

type Ctx = { f: AccountFacts; asOf: string; active: boolean };
type Rule = (c: Ctx) => Signal | Signal[] | null | undefined;

const MIN_BASELINE = 200; // requests in prior 28d before a % change is meaningful
const CONCERN = /(concern|dissatisf|unhappy|no response|lost|churn|cancel|frustrat|escalat|unclear|quiet)/i;

const risk = (id: string, weight: number, source: Signal["source"], label: string, evidence: string): Signal => ({ id, kind: "risk", weight, source, label, evidence });
const growth = (id: string, weight: number, source: Signal["source"], label: string, evidence: string): Signal => ({ id, kind: "growth", weight, source, label, evidence });
const hygiene = (id: string, weight: number, source: Signal["source"], label: string, evidence: string): Signal => ({ id, kind: "hygiene", weight, source, label, evidence });

const recent = (acts: Activity[], asOf: string, days: number) => acts.filter((a) => { const d = daysBetween(a.timestamp, asOf); return d >= 0 && d <= days; });

// ---------------- usage (analytics) ----------------

const usageTrend: Rule = ({ f: { usage: u } }) => {
  if (!u) return null;
  if (u.daysSinceUsage != null && u.daysSinceUsage >= 7 && u.req28 + u.reqPrior28 > 0)
    return risk("usage_stopped", 4, "analytics", "Production usage stopped", `no production API usage for ${u.daysSinceUsage} days (last ${u.lastEventDate})`);
  if (u.reqPrior28 >= MIN_BASELINE && u.changePct != null && u.changePct <= -25)
    return risk("usage_drop", u.changePct <= -50 ? 4 : 3, "analytics", "Usage declining", `requests ${int(u.req28)} in last 28d vs ${int(u.reqPrior28)} in prior 28d (${signed(u.changePct)})`);
  if (u.reqPrior28 >= MIN_BASELINE && u.changePct != null && u.changePct >= 25)
    return growth("usage_growth", u.changePct >= 60 ? 4 : 3, "analytics", "Usage growing", `requests ${int(u.req28)} in last 28d vs ${int(u.reqPrior28)} in prior 28d (${signed(u.changePct)})`);
  if (u.reqPrior28 < MIN_BASELINE && u.req28 >= MIN_BASELINE)
    return growth("usage_new", 2, "analytics", "New production usage", `${int(u.req28)} requests in last 28d vs ${int(u.reqPrior28)} before`);
  return null;
};

const capabilities: Rule = ({ f: { usage: u } }) => {
  if (!u) return null;
  const out: Signal[] = [];
  if (u.agentsNew.length && u.req28 > 0) out.push(growth("new_capability", 2, "analytics", "Adopting new capabilities", `started using ${u.agentsNew.join(", ")} in the last 28d`));
  if (u.agentsDropped.length >= 2) out.push(risk("capability_dropped", 1, "analytics", "Stopped using capabilities", `no use of ${u.agentsDropped.join(", ")} in the last 28d (used in prior 28d)`));
  return out;
};

const pilotNotAdopted: Rule = ({ f }) => {
  const open = f.opportunities.filter(isOpen);
  if (!["mvp", "evaluation"].includes(f.account.stage) || !open.length) return null;
  const top = open.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a));
  if (f.usage && f.usage.req28 === 0 && f.usage.reqPrior28 === 0)
    return risk("pilot_not_adopted", 3, "join", "Pilot/evaluation with no production usage", `stage ${f.account.stage}, open ${top.name ?? top.id} (${money(top.value)}), but 0 production requests in the last 8 weeks`);
  return null;
};

const alerts: Rule = ({ f: { usage: u } }) =>
  u?.alerts.map((al) => {
    const when = day(al.createdAt);
    if (al.alertType === "usage_spike_detected") return growth("alert_spike", 2, "analytics", "Usage spike alert", `"${al.alert}" triggered ${when}`);
    // Low balance + falling usage is a renewal question, not an upsell.
    if ((u.changePct ?? 0) <= -25) return risk("alert_balance", 1, "analytics", "Balance low while usage falls", `"${al.alert}" triggered ${when} while requests are ${signed(u.changePct)} vs prior 28d`);
    return growth("alert_balance", 3, "analytics", "Balance running low", `"${al.alert}" triggered ${when} — top-up / expansion conversation`);
  }) ?? null;

const contracts: Rule = ({ f: { usage: u } }) => {
  if (!u) return null;
  const out: Signal[] = [];
  const hasBalanceAlert = u.alerts.some((a) => a.alertType !== "usage_spike_detected");
  for (const c of u.contracts) {
    if (c.daysToEnd == null) continue;
    if (c.daysToEnd < 0 && u.req28 > 0)
      out.push(risk("contract_expired", 2, "analytics", "Usage on an expired contract", `${c.type} contract ${c.id} ended ${day(c.ending_before)} (${-c.daysToEnd}d ago) but usage continues`));
    else if (c.daysToEnd >= 0 && c.daysToEnd <= 90)
      out.push(risk("renewal_due", c.daysToEnd <= 45 ? 3 : 2, "analytics", "Contract renewal coming up", `${c.type} contract ${c.id} (${money(c.amount)}) ends ${day(c.ending_before)} — in ${c.daysToEnd} days`));
    if (c.pctRemaining != null && c.pctRemaining <= 20 && c.daysToEnd > 0 && !hasBalanceAlert)
      out.push(growth("balance_low", 2, "analytics", "Contract balance nearly used", `${c.pctRemaining}% of ${money(c.amount)} ${c.type} contract left with ${c.daysToEnd}d to go`));
  }
  return out;
};

const stageMismatch: Rule = ({ f, active }) => {
  const u = f.usage;
  if (active || !u || u.req28 < 500) return null;
  // Common in this data (~1 in 4 accounts): a hygiene flag unless usage is actually growing.
  const growing = (u.changePct ?? 0) >= 25;
  const evidence = `${int(u.req28)} production requests in the last 28d${growing ? ` (${signed(u.changePct)})` : ""} while CRM stage is "${f.account.stage}"`;
  return growing ? growth("usage_without_deal", 2, "join", "Growing usage on a non-active CRM stage", evidence) : hygiene("usage_without_deal", 1, "join", "CRM stage contradicts product usage", evidence);
};

const noUsageForCustomer: Rule = ({ f }) =>
  !f.usage && f.account.stage === "customer"
    ? hygiene("customer_no_usage", 1, "join", "Customer with no attributable usage", f.match.status === "ambiguous" ? "usage exists but matches several CRM records" : "no analytics tenant matched this account")
    : null;

// ---------------- engagement (CRM) ----------------

const goingDark: Rule = ({ f, asOf, active }) => {
  if (!active) return null;
  const last = f.account.lastContactAt ?? f.activities[0]?.timestamp;
  const quiet = last ? daysBetween(last, asOf) : null;
  if (quiet != null && quiet < 30) return null;
  return risk("going_dark", quiet == null || quiet >= 60 ? 3 : 2, "crm", "No recent contact", quiet == null ? "no contact recorded" : `last contact ${day(last)} (${quiet} days ago)`);
};

const meetingsAndNotes: Rule = ({ f, asOf }) => [
  ...recent(f.activities, asOf, 60)
    .filter((a) => a.type === "meeting" && a.outcome === "negative")
    .map((m) => risk("negative_meeting", 3, "crm", "Negative meeting", `meeting on ${day(m.timestamp)} marked negative`)),
  ...recent(f.activities, asOf, 90)
    .filter((a): a is Extract<Activity, { type: "note" }> => a.type === "note" && CONCERN.test(a.text))
    .map((n) => risk("concern_note", 2, "crm", "Concern in notes", `note ${day(n.timestamp)}: "${n.text}"`)),
];

const inbound: Rule = ({ f, asOf }) => {
  const latest = recent(f.activities, asOf, 14).find((a) => a.type === "email" && a.direction === "inbound");
  if (!latest) return null;
  // Activities are newest first; an outbound email or meeting after the inbound counts as a reply.
  const replied = f.activities.some((a) => a.timestamp > latest.timestamp && ((a.type === "email" && a.direction === "outbound") || a.type === "meeting"));
  const subject = latest.type === "email" ? latest.subject ?? "(no subject)" : "";
  return replied
    ? growth("inbound_followed_up", 1, "crm", "Customer reached out (followed up)", `inbound email "${subject}" ${day(latest.timestamp)}; a later outbound email/meeting is logged`)
    : growth("awaiting_reply", 2, "crm", "Customer email awaiting reply", `inbound email "${subject}" ${day(latest.timestamp)}; no outbound email or meeting logged since`);
};

// ---------------- pipeline (CRM) ----------------

const pipeline: Rule = ({ f, asOf }) =>
  f.opportunities.filter(isOpen).flatMap((o) => {
    const name = `${o.name ?? o.id} (${money(o.value)}, ${o.stage})`;
    const out: Signal[] = [];
    if (o.closeDate && o.closeDate < asOf) out.push(risk("opp_slipped", 3, "crm", "Opportunity past close date", `${name} was due ${o.closeDate}`));
    else if (o.closeDate && daysBetween(asOf, o.closeDate) <= 30) out.push(growth("opp_closing", 2, "crm", "Opportunity closing soon", `${name} closes ${o.closeDate} — in ${daysBetween(asOf, o.closeDate)} days`));
    if (o.lastStageChangeAt && daysBetween(o.lastStageChangeAt, asOf) >= 60)
      out.push(risk("opp_stalled", 1, "crm", "Opportunity not progressing", `${name} unchanged since ${day(o.lastStageChangeAt)} (${daysBetween(o.lastStageChangeAt, asOf)}d)`));
    if (!o.nextStep && !f.account.nextStep) out.push(hygiene("no_next_step", 1, "crm", "Open opportunity without a next step", `${o.name ?? o.id} has no next step recorded`));
    return out;
  });

// ---------------- hygiene ----------------

const overdueTasks: Rule = ({ f, asOf }) => {
  const overdue = f.tasks.filter((t) => !t.completed && t.dueDate && t.dueDate < asOf).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  if (!overdue.length) return null;
  return hygiene("overdue_tasks", overdue.length >= 3 ? 2 : 1, "crm", "Overdue tasks", `${overdue.length} open task(s) past due, oldest "${overdue[0].title ?? "(untitled)"}" due ${overdue[0].dueDate}`);
};

const singleThreaded: Rule = ({ f, active }) =>
  (active || f.opportunities.some(isOpen)) && f.contacts.length <= 1 ? risk("single_threaded", 1, "crm", "Single-threaded", `${f.contacts.length} contact(s) on record`) : null;

const relatedRecords: Rule = ({ f }) => {
  const dups = f.match.related.filter((r) => r.relation === "duplicate").map((r) => r.id);
  return dups.length ? hygiene("duplicate_record", 1, "join", "Possible duplicate CRM record", `looks like the same company as ${dups.join(", ")}`) : null;
};

export const RULES: readonly Rule[] = [
  usageTrend, capabilities, pilotNotAdopted, alerts, contracts, stageMismatch, noUsageForCustomer,
  goingDark, meetingsAndNotes, inbound, pipeline, overdueTasks, singleThreaded, relatedRecords,
];

export function computeSignals(f: AccountFacts, asOf: string): Signal[] {
  const ctx: Ctx = { f, asOf, active: ACTIVE_STAGES.has(f.account.stage) };
  return RULES.flatMap((rule) => [rule(ctx) ?? []].flat());
}
