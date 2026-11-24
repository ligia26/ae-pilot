/**
 * One conversational turn: route -> facts -> (clarify | LLM) -> grounding checks.
 * The model only phrases and prioritises facts it is given. When the question
 * can't be resolved (ambiguous or unknown names), the tool answers itself
 * without calling the model.
 */
import type { Snapshot } from "../data/snapshot.ts";
import type { ChatMessage, LlmFn } from "../llm/llm.ts";
import { buildFacts } from "./facts.ts";
import { extractActions, groundingWarnings, idsIn, type ProposedAction } from "./grounding.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import { route, type Route } from "./router.ts";

export type Turn = { answer: string; route: Route; facts: string; actions: ProposedAction[]; warnings: string[]; usedLlm: boolean; clarification: boolean };

const HISTORY_TURNS = 3;

/** Deterministic reply when the question names nothing we can resolve. */
function clarification(r: Route): string | null {
  const { accounts, orphans, ambiguous, unknownIds, notFound } = r.resolution;
  if (accounts.length || orphans.length) return null;
  const lines: string[] = [];
  for (const id of unknownIds) lines.push(`There's no CRM account with id ${id}.`);
  for (const name of notFound) lines.push(`I can't find "${name}" in the CRM or the usage data.`);
  for (const a of ambiguous) lines.push(`"${a.term}" matches several companies — which one?\n${a.candidates.map((c) => `  - [${c.account.id}] ${c.account.name} (${c.account.stage}, owner ${c.account.ownerId ?? "?"})`).join("\n")}`);
  return lines.length ? lines.join("\n") : null;
}

export class Assistant {
  owner: string | null = process.env.AE_OWNER ?? null;
  lastFacts = "";
  private history: ChatMessage[] = [];
  private lastAccountIds: string[] = [];

  constructor(private readonly snap: Snapshot, private readonly llm: LlmFn | null) {}

  reset(): void {
    this.history = [];
    this.lastAccountIds = [];
  }

  async ask(question: string): Promise<Turn> {
    const r = route(question, this.snap, this.owner, this.lastAccountIds);
    const facts = buildFacts(r, this.snap);
    this.lastFacts = facts;
    const base = { route: r, facts, actions: [] as ProposedAction[], warnings: [] as string[], usedLlm: false, clarification: false };

    const clarify = clarification(r);
    if (clarify) return { ...base, answer: clarify, clarification: true };
    if (!this.llm) return { ...base, answer: facts, warnings: ["LLM unavailable — showing the underlying facts"] };

    let raw: string;
    try {
      raw = (await this.llm([{ role: "system", content: SYSTEM_PROMPT }, ...this.history.slice(-HISTORY_TURNS * 2), { role: "user", content: userMessage(facts, this.owner, question) }])).trim();
    } catch (e) {
      return { ...base, answer: facts, warnings: [`LLM call failed (${(e as Error).message}) — showing the underlying facts instead`] };
    }

    const given = idsIn(facts);
    const { text, actions } = extractActions(raw, given);
    this.history.push({ role: "user", content: question }, { role: "assistant", content: text });
    const cited = [...idsIn(text)].filter((id) => given.has(id));
    this.lastAccountIds = (r.resolution.accounts.length ? r.resolution.accounts.map((v) => v.account.id) : cited).slice(0, 3);
    return { ...base, answer: text, actions, warnings: groundingWarnings(text, facts), usedLlm: true };
  }
}
