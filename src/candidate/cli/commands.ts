/** Slash commands: deterministic, no LLM. Returns true when the input was a command. */
import type { Assistant } from "../conversation/assistant.ts";
import { dossier } from "../conversation/facts.ts";
import { resolve } from "../conversation/resolver.ts";
import type { Snapshot } from "../data/snapshot.ts";
import { dataReport, overview } from "./views.ts";

export const HELP = `Ask anything in plain English, e.g.
  "what should I focus on today?"     "which customers are at risk?"
  "who is ready to expand?"           "what happened last week?"
  "tell me about HearthPediatrics"    "what should I do there?"
  "what can I ignore this week?"
Commands:
  /owner <id|all>   scope to one AE's book        /owners   list owners
  /account <name>   full account details (no LLM)  /facts    facts behind the last answer
  /data             join & data-quality report     /reset    clear conversation memory
  /help             this help                      /quit     exit`;

type Handler = (arg: string, ctx: { snap: Snapshot; assistant: Assistant }) => string;

const COMMANDS: Record<string, Handler> = {
  help: () => HELP,
  facts: (_a, { assistant }) => assistant.lastFacts || "(no question asked yet)",
  data: (_a, { snap }) => dataReport(snap),
  owners: (_a, { snap }) => snap.owners.join(", "),
  reset: (_a, { assistant }) => (assistant.reset(), "Conversation cleared."),
  owner: (arg, { snap, assistant }) => {
    if (!arg || arg === "all") assistant.owner = null;
    else if (!snap.owners.includes(arg)) return `Unknown owner "${arg}". Owners: ${snap.owners.join(", ")}`;
    else assistant.owner = arg;
    assistant.reset();
    return overview(snap, assistant.owner);
  },
  account: (arg, { snap }) => {
    const r = resolve(arg, snap);
    if (r.accounts.length) return r.accounts.map((v) => dossier(v, snap)).join("\n\n");
    if (r.ambiguous.length) return r.ambiguous.map((a) => `"${a.term}" matches: ${a.candidates.map((c) => `[${c.account.id}] ${c.account.name}`).join(", ")}`).join("\n");
    return "No account matched that name or id.";
  },
};

export function runCommand(input: string, ctx: { snap: Snapshot; assistant: Assistant }): string | null {
  const m = input.match(/^\/(\w+)\s*(.*)$/);
  if (!m) return null;
  const handler = COMMANDS[m[1].toLowerCase()];
  return handler ? handler(m[2].trim(), ctx) : `Unknown command /${m[1]}. Type /help.`;
}
