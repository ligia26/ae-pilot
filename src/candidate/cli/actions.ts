/** Shows suggested CRM actions once as a numbered list and writes only the ones the AE picks. */
import type { ProposedAction } from "../conversation/grounding.ts";
import type { CrmClient } from "../data/crm-client.ts";

export type Ask = (prompt: string) => Promise<string | null>;

const describe = (a: ProposedAction) =>
  a.type === "task" ? `task on ${a.accountId}: "${a.title}"${a.dueDate ? ` (due ${a.dueDate})` : ""}` : `note on ${a.accountId}: "${a.text}"`;

/** "1,3" -> [0, 2]; "all" -> every index; anything else -> none. */
export function parseSelection(input: string, count: number): number[] {
  const s = input.trim().toLowerCase();
  if (s === "all") return [...Array(count).keys()];
  return [...new Set(s.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= count).map((n) => n - 1))];
}

export async function offerActions(ask: Ask, crm: CrmClient, actions: ProposedAction[]): Promise<void> {
  if (!actions.length) return;
  console.log("Suggested CRM actions:");
  actions.forEach((a, i) => console.log(`  ${i + 1}. ${describe(a)}`));
  const picked = parseSelection((await ask("Save which? (e.g. 1,3 · all · Enter for none) ")) ?? "", actions.length);
  for (const i of picked) {
    const a = actions[i];
    try {
      if (a.type === "task") await crm.createTask(a.accountId, a.title, a.dueDate);
      else await crm.addNote(a.accountId, a.text);
      console.log(`  ✓ saved ${i + 1}`);
    } catch (e) {
      console.log(`  ✗ ${i + 1} failed: ${(e as Error).message}`);
    }
  }
}
