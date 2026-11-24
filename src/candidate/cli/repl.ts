/** Terminal loop. Reads lines via an async iterator so piped/pasted input isn't lost while the model thinks. */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Assistant } from "../conversation/assistant.ts";
import type { CrmClient } from "../data/crm-client.ts";
import type { Snapshot } from "../data/snapshot.ts";
import { offerActions, type Ask } from "./actions.ts";
import { runCommand } from "./commands.ts";

export async function repl(ctx: { snap: Snapshot; assistant: Assistant; crm: CrmClient }): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask: Ask = async (prompt) => {
    stdout.write(prompt);
    const next = await lines.next();
    if (!stdin.isTTY && !next.done) stdout.write(`${next.value}\n`); // echo piped input
    return next.done ? null : next.value;
  };

  for (;;) {
    const raw = await ask("AE › ");
    if (raw == null) break;
    const q = raw.trim();
    if (!q) continue;
    if (q === "/quit" || q === "/exit") break;

    const commandOutput = runCommand(q, ctx);
    if (commandOutput != null) { console.log(commandOutput); continue; }

    stdout.write("… thinking\r");
    const t = await ctx.assistant.ask(q);
    console.log(`\n${t.answer}\n`);
    for (const w of t.warnings) console.log(`⚠ ${w}`);
    const accounts = t.route.resolution.accounts.map((v) => v.account.id);
    if (!t.clarification) console.log(`  (based on: ${t.route.intents.join(", ")}${accounts.length ? ` · ${accounts.join(", ")}` : ""}${t.usedLlm ? "" : " · no LLM"} — /facts to inspect)`);
    await offerActions(ask, ctx.crm, t.actions);
    console.log();
  }
  rl.close();
}
