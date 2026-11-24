/** Post-checks on model output: cited ids must come from the facts; actions are parsed and filtered. */

export type ProposedAction =
  | { type: "task"; accountId: string; title: string; dueDate?: string }
  | { type: "note"; accountId: string; text: string };

const ID = /acc_\d{3}/g;
const ACTION = /^\s*ACTION:\s*(task|note)\s*\|\s*(acc_\d{3})\s*\|\s*([^|]+?)\s*(?:\|\s*(\d{4}-\d{2}-\d{2}))?\s*$/i;
const MAX_ACTIONS = 3;

export const idsIn = (text: string): Set<string> => new Set(text.match(ID) ?? []);

export function groundingWarnings(answer: string, facts: string): string[] {
  const given = idsIn(facts);
  const invented = [...idsIn(answer)].filter((id) => !given.has(id));
  return invented.length ? [`answer mentions account(s) not in the supplied facts: ${invented.join(", ")} — treat those parts as unverified`] : [];
}

/** Splits ACTION lines out of the answer; drops actions on accounts the model wasn't shown. */
export function extractActions(answer: string, allowedIds: Set<string>): { text: string; actions: ProposedAction[] } {
  const actions: ProposedAction[] = [];
  const kept: string[] = [];
  for (const line of answer.split("\n")) {
    const m = line.match(ACTION);
    if (!m) { kept.push(line); continue; }
    const [, type, accountId, body, due] = m;
    if (!allowedIds.has(accountId)) continue;
    actions.push(type.toLowerCase() === "task" ? { type: "task", accountId, title: body, dueDate: due } : { type: "note", accountId, text: body });
  }
  return { text: kept.join("\n").trim(), actions: actions.slice(0, MAX_ACTIONS) };
}
