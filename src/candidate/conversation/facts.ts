/**
 * Formats the smallest set of facts that answers a routed question.
 * Every line carries the account id, the system it came from, and the numbers
 * behind it; date gaps and book totals are computed here so the model never
 * has to do arithmetic or claim things about accounts it hasn't seen.
 */
import type { Snapshot } from "../data/snapshot.ts";
import { summariseEvents } from "../domain/events.ts";
import { ACTIVE_STAGES, daysBetween, day, int, isOpen, money, signed } from "../domain/format.ts";
import type { AccountView, Signal, SignalKind } from "../domain/types.ts";
import type { Route } from "./router.ts";

const LIST_SIZE = 10;

// ---------------- building blocks ----------------

function confidenceTag(v: AccountView): string {
  return v.confidence === "high" ? "data confidence HIGH" : `data confidence ${v.confidence.toUpperCase()} (${v.confidenceReasons.join("; ")})`;
}

function header(v: AccountView): string {
  const a = v.account;
  return `[${a.id}] ${a.name} | account owner ${a.ownerId ?? "unassigned"} | stage ${a.stage} | ${a.icpTier ?? "tier ?"} | value at stake ${money(v.value)} | priority ${v.priority.toFixed(1)} (risk ${v.risk}, growth ${v.growth}) | ${confidenceTag(v)}`;
}

const signalLine = (s: Signal) => `  - ${s.kind.toUpperCase()} (${s.source}) ${s.label}: ${s.evidence}`;

function brief(v: AccountView, kinds: SignalKind[] = ["risk", "growth", "hygiene"]): string {
  return [header(v), ...v.signals.filter((s) => kinds.includes(s.kind)).map(signalLine)].join("\n");
}

/** Pre-computed date gaps, so the model quotes them instead of calculating. */
function keyDates(v: AccountView, asOf: string): string {
  const parts: string[] = [];
  const last = v.account.lastContactAt ?? v.activities[0]?.timestamp;
  parts.push(last ? `last contact ${day(last)} (${daysBetween(last, asOf)} days ago)` : "no contact recorded");
  const contracts = (v.usage?.contracts ?? []).filter((c) => c.daysToEnd != null && c.daysToEnd >= 0);
  for (const o of v.opportunities.filter(isOpen)) {
    if (!o.closeDate) continue;
    parts.push(`${o.id} closes ${o.closeDate} (in ${daysBetween(asOf, o.closeDate)} days)`);
    for (const c of contracts) {
      const gap = daysBetween(c.ending_before!, o.closeDate);
      parts.push(`${c.id} ends ${Math.abs(gap)} days ${gap >= 0 ? "before" : "after"} ${o.id} closes`);
    }
  }
  for (const c of contracts) parts.push(`${c.id} ends ${day(c.ending_before)} (in ${c.daysToEnd} days)`);
  return `  Key dates: ${parts.join("; ")}`;
}

export function dossier(v: AccountView, snap: Snapshot): string {
  const a = v.account;
  const u = v.usage;
  const lines = [header(v)];
  lines.push(`  CRM: industry ${a.industry ?? "?"}, ${a.employeeCount ?? "?"} employees, next step "${a.nextStep ?? "none"}"`);
  lines.push(keyDates(v, snap.asOf));
  lines.push(`  Contacts (${v.contacts.length}): ${v.contacts.map((c) => `${c.name} (title ${c.title ?? "?"}, persona ${c.persona ?? "?"}, last contacted ${day(c.lastContactedAt)})`).join("; ") || "none on record"}`);
  lines.push(`  Opportunities: ${v.opportunities.map((o) => `${o.id} "${o.name ?? ""}" ${o.stage}/${o.status ?? "?"} ${money(o.value)} close ${o.closeDate ?? "?"} next step "${o.nextStep ?? "none"}" opportunity owner ${o.ownerId ?? "?"}`).join("; ") || "none"}`);
  const open = v.tasks.filter((t) => !t.completed);
  lines.push(`  Open tasks (${open.length}): ${open.slice(0, 6).map((t) => `"${t.title ?? "(untitled)"}" due ${t.dueDate ?? "?"}`).join("; ") || "none"}`);
  lines.push(`  Recent activity (newest first): ${v.activities.slice(0, 8).map((x) => `${day(x.timestamp)} ${x.type === "email" ? `${x.direction} email "${x.subject ?? ""}"` : x.type === "meeting" ? `meeting ${x.outcome ?? "(no outcome)"}` : x.type === "note" ? `note "${x.text}"` : `stage ${x.from ?? "?"}->${x.to}`}`).join("; ") || "none logged"}`);
  if (u) {
    lines.push(`  Usage (production, excl. NFR): weekly requests newest->oldest [${u.weeklyRequests.slice(0, 8).join(", ")}]; last 28d ${int(u.req28)} vs prior 28d ${int(u.reqPrior28)} (${signed(u.changePct)}); last usage ${u.lastEventDate ?? "never"}; capabilities in use: ${u.agentsRecent.join(", ") || "none"}; active API keys ${u.activeKeys} (${u.keysUsedLast14d} used in last 14d)`);
    lines.push(`  Contracts: ${u.contracts.map((c) => `${c.id} ${c.type} ${money(c.amount)}, ${c.pctRemaining ?? "?"}% balance left, ends ${day(c.ending_before)}`).join("; ") || "none on record"}`);
  } else {
    const why = v.match.status === "ambiguous" ? `ambiguous: ${v.match.ambiguousWith.map((x) => `${x.customerName} matches ${x.candidates.join(" and ")}`).join("; ")}` : "no matching analytics tenant";
    lines.push(`  Usage: none attributed (${why})`);
  }
  lines.push(`  Data join: ${v.match.customers.map((m) => `${m.customerName} via ${m.method.replace("_", " ")} (${m.confidence}${m.note ? `, ${m.note}` : ""})`).join("; ") || "none"}`);
  if (v.match.related.length)
    lines.push(`  Related CRM records: ${v.match.related.map((r) => `${r.id} ${snap.byId.get(r.id)?.account.name ?? ""} (${r.relation}, stage ${snap.byId.get(r.id)?.account.stage ?? "?"})`).join("; ")}`);
  lines.push("  Signals:", ...(v.signals.length ? v.signals.map(signalLine) : ["  - none"]));
  return lines.join("\n");
}

function bookTotals(scope: AccountView[]): string {
  const byStage = new Map<string, number>();
  for (const v of scope) byStage.set(v.account.stage, (byStage.get(v.account.stage) ?? 0) + 1);
  const atRisk = scope.filter((v) => ACTIVE_STAGES.has(v.account.stage) && v.risk >= 3);
  const growing = scope.filter((v) => v.growth >= 3);
  const top = [...scope].sort((a, b) => b.value - a.value)[0];
  return [
    `BOOK TOTALS (whole scope, use these for any book-wide claim): ${[...byStage].map(([s, n]) => `${s} ${n}`).join(", ")}`,
    `  ${atRisk.length} active accounts with risk score >= 3, total value at stake ${money(atRisk.reduce((a, v) => a + v.value, 0))}`,
    `  ${growing.length} accounts with growth score >= 3, total value ${money(growing.reduce((a, v) => a + v.value, 0))}`,
    top ? `  largest value at stake in scope: [${top.account.id}] ${top.account.name} ${money(top.value)}` : "",
  ].filter(Boolean).join("\n");
}

const ranked = (list: AccountView[], key: (v: AccountView) => number) => list.filter((v) => key(v) > 0).sort((a, b) => key(b) - key(a)).slice(0, LIST_SIZE);

// ---------------- sections ----------------

type Section = (scope: AccountView[], snap: Snapshot, route: Route) => string | null;

const SECTIONS: Record<Route["intents"][number], Section> = {
  account: (_s, snap, r) => {
    const parts = r.resolution.accounts.map((v) => dossier(v, snap));
    for (const o of r.resolution.orphans)
      parts.push(`[no CRM account] analytics tenant ${o.customerName}: ${int(o.req28)} production requests in last 28d (${signed(o.changePct)} vs prior 28d). Not linked to any CRM account, so no owner, stage, contacts or pipeline are known.`);
    return parts.length ? `ACCOUNT DETAILS:\n${parts.join("\n\n")}` : null;
  },
  today: (scope) => `TOP PRIORITIES (deterministic priority = risk + growth weights + value boost):\n${ranked(scope, (v) => v.priority).map((v) => brief(v)).join("\n") || "none"}`,
  risk: (scope) => `HIGHEST RISK (active stages only, top ${LIST_SIZE}):\n${ranked(scope.filter((v) => ACTIVE_STAGES.has(v.account.stage)), (v) => v.risk).map((v) => brief(v, ["risk"])).join("\n") || "none"}`,
  growth: (scope) => `STRONGEST GROWTH SIGNALS (top ${LIST_SIZE}):\n${ranked(scope, (v) => v.growth).map((v) => brief(v, ["growth"])).join("\n") || "none"}`,
  hygiene: (scope, snap) =>
    `CRM HYGIENE ISSUES (top ${LIST_SIZE}):\n${ranked(scope, (v) => v.hygiene).map((v) => brief(v, ["hygiene"])).join("\n") || "none"}\n` +
    `PRODUCT USAGE WITH NO CRM ACCOUNT: ${snap.orphanUsage.map((o) => `${o.customerName} (${int(o.req28)} requests/28d)`).join("; ") || "none"}`,
  quiet: (scope) => {
    const noSignals = scope.filter((v) => ACTIVE_STAGES.has(v.account.stage) && v.risk === 0 && v.growth === 0);
    const safe = noSignals.filter((v) => v.confidence === "high");
    const unclear = noSignals.filter((v) => v.confidence !== "high");
    const inactive = scope.filter((v) => !ACTIVE_STAGES.has(v.account.stage) && v.risk === 0 && v.growth === 0).length;
    const line = (v: AccountView) => `[${v.account.id}] ${v.account.name} | ${v.account.stage} | ${money(v.value)} | ${confidenceTag(v)}${v.hygiene ? ` | hygiene only: ${v.signals.map((s) => s.label).join(", ")}` : ""}`;
    return [
      `ACTIVE ACCOUNTS WITH NO RISK OR GROWTH SIGNALS AND HIGH DATA CONFIDENCE (${safe.length}; reasonable to deprioritise today):`,
      safe.slice(0, 15).map(line).join("\n") || "none",
      `NO SIGNALS BUT LOW/MEDIUM DATA CONFIDENCE (${unclear.length}; NOT safe to ignore — the data may be missing, not quiet):`,
      unclear.slice(0, 10).map(line).join("\n") || "none",
      `Also ${inactive} prospect/closed-lost accounts with no signals at all.`,
    ].join("\n");
  },
  week: (scope, snap) => {
    const s = summariseEvents(scope, snap.asOf);
    return `LAST ${s.days} DAYS TO ${snap.asOf}. Counts: ${Object.entries(s.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "no activity"}.\n` +
      `NOTABLE (routine emails omitted):\n${s.notable.slice(0, 30).map((e) => `  ${e.date} [${e.accountId}] ${e.accountName} (${e.source}): ${e.what}`).join("\n") || "  none"}`;
  },
};

function lookupNotes(r: Route): string | null {
  const { unknownIds, notFound, ambiguous } = r.resolution;
  const notes = [
    unknownIds.length ? `No CRM account has id ${unknownIds.join(", ")}.` : "",
    notFound.length ? `No account, CRM or analytics, matches: ${notFound.join(", ")}.` : "",
    ...ambiguous.map((a) => `"${a.term}" matches several companies: ${a.candidates.map((c) => `[${c.account.id}] ${c.account.name}`).join(", ")}.`),
  ].filter(Boolean);
  return notes.length ? `LOOKUP NOTES:\n${notes.join("\n")}` : null;
}

export function buildFacts(r: Route, snap: Snapshot): string {
  const scope = snap.views.filter((v) => !r.owner || v.account.ownerId === r.owner);
  const intro = `DATA AS OF ${snap.asOf} (last day of product usage data; "today" means this date). Scope: ${scope.length} accounts${r.owner ? ` owned by ${r.owner}` : " (all owners)"}.`;
  return [intro, bookTotals(scope), lookupNotes(r), ...r.intents.map((i) => SECTIONS[i](scope, snap, r))].filter(Boolean).join("\n\n");
}
