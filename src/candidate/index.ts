/**
 * AE Copilot — terminal chat over CRM + product usage, powered by Corti Models.
 *
 *   npm run dev   # terminal 1: mock CRM on :3001
 *   npm run ae    # terminal 2: this tool (alias: npm run challenge)
 *
 * Env (see .env.example): Corti credentials, AE_OWNER, CORTI_MODEL, AS_OF, NO_LLM=1
 * This file only wires the pieces together.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listModels } from "../../lib/corti.ts";
import { overview } from "./cli/views.ts";
import { repl } from "./cli/repl.ts";
import { Assistant } from "./conversation/assistant.ts";
import { CrmClient } from "./data/crm-client.ts";
import { buildSnapshot } from "./data/snapshot.ts";
import { authNote, ensureCortiToken, hasClientCredentials } from "./llm/corti-auth.ts";
import { cortiLlm, type LlmFn } from "./llm/llm.ts";

const ANALYTICS_PATH = process.env.ANALYTICS_DB ?? resolve(fileURLToPath(new URL("../..", import.meta.url)), "data/analytics/analytics.sqlite");

async function connectLlm(): Promise<LlmFn | null> {
  if (process.env.NO_LLM) return (console.log("· NO_LLM set — answers show the underlying facts only"), null);
  if (!process.env.CORTI_API_KEY && !process.env.CORTI_TOKEN_CMD && !hasClientCredentials())
    return (console.log("· No Corti credentials in .env.local — answers show the underlying facts only"), null);
  try {
    await ensureCortiToken();
    const models = await listModels();
    console.log(`· Corti Models connected (model: ${process.env.CORTI_MODEL ?? "default"}; available: ${models.map((m) => m.id).join(", ")}) — ${authNote()}`);
    return cortiLlm();
  } catch (e) {
    console.log(`· Corti Models unavailable (${(e as Error).message}) — answers show the underlying facts only`);
    return null;
  }
}

export async function run(): Promise<void> {
  const crm = new CrmClient();
  try {
    await crm.health();
  } catch {
    console.error(`Cannot reach the CRM at ${crm.baseUrl}. Start it first with: npm run dev`);
    process.exit(1);
  }
  const snap = await buildSnapshot({ analyticsPath: ANALYTICS_PATH, crm, onProgress: (m) => console.log(`· ${m}`) });
  const assistant = new Assistant(snap, await connectLlm());
  if (assistant.owner && !snap.owners.includes(assistant.owner)) {
    console.log(`· AE_OWNER "${assistant.owner}" owns no accounts — showing all owners`);
    assistant.owner = null;
  }
  console.log(`\n${overview(snap, assistant.owner)}\n\nType a question, or /help.\n`);
  await repl({ snap, assistant, crm });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
