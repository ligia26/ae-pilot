/**
 * Decides which views of the book a question needs (intents) and which accounts
 * it is about. Deterministic and cheap, so routing is predictable and testable.
 */
import type { Snapshot } from "../data/snapshot.ts";
import { resolve, type Resolution } from "./resolver.ts";

export type Intent = "account" | "today" | "risk" | "growth" | "week" | "hygiene" | "quiet";
export type Route = { intents: Intent[]; resolution: Resolution; owner: string | null; followUp: boolean };

const INTENTS: Array<[Intent, RegExp]> = [
  ["quiet", /\b(ignore|deprioriti[sz]e|skip|quiet|safe to|low.priority|nothing to do|can wait)\b/i],
  ["risk", /\b(risk|risky|churn|worr|declin|drop|at.risk|losing|slipp|dark|concern|problem)/i],
  ["growth", /\b(grow|expan|upsell|ready|opportunit|pipeline|close|closing|top.?up|upgrade|spike)/i],
  ["week", /\b(last week|this week|past week|happened|recent|lately|yesterday|since)/i],
  ["hygiene", /\b(hygiene|clean|duplicate|data quality|overdue|stale|crm update)/i],
  ["today", /\b(today|focus|priorit|attention|standup|first|start|should i)/i],
];
// Pronouns that point back at accounts discussed before. Deliberately excludes "this"/"that"
// on their own, which appear in time phrases ("this week") far more than as references.
const BACK_REFERENCE = /\b(it|its|them|they|their|there|that account|this account|those accounts|these accounts|that one|this one)\b/i;

export function route(question: string, snap: Snapshot, owner: string | null, previousAccountIds: string[] = []): Route {
  let resolution = resolve(question, snap);
  const intents = INTENTS.filter(([, re]) => re.test(question)).map(([i]) => i);

  const nothingNamed = !resolution.accounts.length && !resolution.ambiguous.length && !resolution.orphans.length;
  const followUp = nothingNamed && previousAccountIds.length > 0 && BACK_REFERENCE.test(question);
  if (followUp) resolution = { ...resolution, accounts: previousAccountIds.map((id) => snap.byId.get(id)).filter((v) => !!v) as Resolution["accounts"] };

  if (resolution.accounts.length || resolution.orphans.length) {
    // "what should I do there?" is about the account, not the whole book.
    const i = intents.indexOf("today");
    if (i >= 0) intents.splice(i, 1);
    intents.unshift("account");
  }
  if (!intents.length) intents.push("today");
  return { intents: [...new Set(intents)], resolution, owner, followUp };
}
