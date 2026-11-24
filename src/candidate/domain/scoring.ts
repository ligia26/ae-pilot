/** Turns signals into a priority and a data-confidence level with reasons. */
import { isOpen } from "./format.ts";
import type { AccountFacts, AccountView, Confidence, Signal, SignalKind } from "./types.ts";

const total = (signals: Signal[], kind: SignalKind) => signals.filter((s) => s.kind === kind).reduce((a, s) => a + s.weight, 0);

/** Money at stake: the larger of open pipeline, the CRM opportunity amount, and live contract value. */
export function valueAtStake(f: AccountFacts): number {
  const pipeline = f.opportunities.filter(isOpen).reduce((a, o) => a + (o.value ?? 0), 0);
  const contracts = f.usage?.contracts.reduce((a, c) => a + ((c.daysToEnd ?? -1) >= 0 ? c.amount ?? 0 : 0), 0) ?? 0;
  return Math.max(pipeline, f.account.opportunityAmount ?? 0, contracts);
}

export function dataConfidence(f: AccountFacts): { confidence: Confidence; reasons: string[] } {
  const reasons: string[] = [];
  if (f.match.status === "none" && f.account.stage !== "prospect") reasons.push("no product usage matched to this account");
  if (f.match.status === "ambiguous") reasons.push("usage matches several CRM records, so it is not attributed");
  for (const m of f.match.customers)
    if (m.confidence !== "high") reasons.push(`usage matched via ${m.method.replace("_", " ")} (${m.customerName})${m.note ? `: ${m.note}` : ""}`);
    else if (m.note) reasons.push(`${m.customerName}: ${m.note}`);
  if (f.crmGaps) reasons.push("some CRM requests failed, so the CRM view is incomplete");
  if (!f.account.lastContactAt) reasons.push("no last-contact date in CRM");

  const low = f.match.status === "ambiguous" || f.crmGaps || f.match.customers.some((m) => m.confidence === "low");
  const medium = f.match.customers.some((m) => m.confidence === "medium") || reasons.length > 0;
  return { confidence: low ? "low" : medium ? "medium" : "high", reasons };
}

export function score(f: AccountFacts, signals: Signal[]): AccountView {
  const risk = total(signals, "risk");
  const growth = total(signals, "growth");
  const hygiene = total(signals, "hygiene");
  const value = valueAtStake(f);
  // Money at stake nudges the order; it does not dominate it.
  const valueBoost = value >= 300_000 ? 2 : value >= 100_000 ? 1 : 0;
  const { confidence, reasons } = dataConfidence(f);
  return { ...f, signals, risk, growth, hygiene, value, priority: risk + growth + valueBoost + Math.min(hygiene, 1) * 0.5, confidence, confidenceReasons: reasons };
}
