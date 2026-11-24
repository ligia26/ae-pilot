/**
 * Solution tests. Unit tests use small fixtures; the e2e suite runs the real
 * analytics DB against the provided mock CRM (in-process) with a fake LLM.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { analyticsNameStem, crmNameStem, hostStem, joinAccounts } from "../src/candidate/domain/join.ts";
import { computeSignals } from "../src/candidate/domain/signals.ts";
import { summariseUsage } from "../src/candidate/domain/usage.ts";
import type { AccountFacts, CustomerUsage } from "../src/candidate/domain/types.ts";
import { extractActions, groundingWarnings } from "../src/candidate/conversation/grounding.ts";
import { parseSelection } from "../src/candidate/cli/actions.ts";
import { Assistant } from "../src/candidate/conversation/assistant.ts";
import { resolve } from "../src/candidate/conversation/resolver.ts";
import { route } from "../src/candidate/conversation/router.ts";
import { buildFacts } from "../src/candidate/conversation/facts.ts";
import { buildSnapshot, type Snapshot } from "../src/candidate/data/snapshot.ts";
import { CrmClient } from "../src/candidate/data/crm-client.ts";

const ANALYTICS = resolvePath(import.meta.dirname, "..", "data", "analytics", "analytics.sqlite");
const AS_OF = "2025-03-14";

// ---------------- fixtures ----------------
const tenant = (recent: number, prior: number, extra: Partial<CustomerUsage> = {}): CustomerUsage => ({
  customerId: "c", lastEventDate: AS_OF, agentsRecent: [], agentsPrior: [], activeKeys: 1, keysUsedLast14d: 1, contracts: [], alerts: [],
  weekly: { requests: [recent, recent, recent, recent, prior, prior, prior, prior, 0, 0, 0, 0], tokens: Array(12).fill(0), transcribe: Array(12).fill(0) },
  ...extra,
});
const facts = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  account: { id: "acc_100", name: "Test Co", stage: "customer", createdAt: "", updatedAt: "", lastContactAt: "2025-03-10" },
  contacts: [{ id: "c1", accountId: "acc_100", name: "A", email: "a@x" }, { id: "c2", accountId: "acc_100", name: "B", email: "b@x" }],
  activities: [], opportunities: [], tasks: [], crmGaps: false, usage: null,
  match: { status: "matched", confidence: "high", customers: [], ambiguousWith: [], related: [] },
  ...over,
});
const ids = (f: AccountFacts) => computeSignals(f, AS_OF).map((s) => s.id);

// ---------------- join ----------------
describe("join", () => {
  test("normalises identifiers from both systems to the same stem", () => {
    assert.equal(hostStem("hearthpediatrics.example"), "hearthpediatrics");
    assert.equal(hostStem("billing@acmetelemedicine.example"), "acmetelemedicine");
    assert.equal(hostStem("acmetelemedicinecustomers.example"), "acmetelemedicine");
    assert.equal(hostStem("sage-medgroup.example"), "sagemedgroup");
    assert.equal(analyticsNameStem("cedarseniorprod"), "cedarsenior");
    assert.equal(analyticsNameStem("crestlinechild-eu"), "crestlinechild");
    assert.equal(crmNameStem("RedwoodHealth Healthcare"), "redwoodhealth");
  });

  test("ranks domain > email > name, attributes to the only live duplicate, refuses true ties", () => {
    const accounts = [
      { id: "a1", name: "Hearth Group", domain: "hearth.example", stage: "customer" },
      { id: "a2", name: "Cedar Ltd", domain: null, stage: "customer" },
      { id: "a3", name: "Twin LLC", domain: "twin.example", stage: "evaluation" },
      { id: "a4", name: "Twin Inc", domain: "twin.example", stage: "evaluation" },
      { id: "a5", name: "Old LLC", domain: "old.example", stage: "closed_lost" },
      { id: "a6", name: "Old Inc", domain: "old.example", stage: "customer" },
    ];
    const c = (id: string, name: string, domain: string | null, email: string | null) => ({ id, customer_name: name, domain, billing_email: email, owner_email: null, environment_type: "PRODUCTION" });
    const r = joinAccounts(accounts, [c("c1", "hearth-prod", "hearth", null), c("c2", "cedar-prod", null, "billing@cedar.example"), c("c3", "twin-prod", "twin", null), c("c4", "old-prod", "old", null), c("c5", "nobody-prod", "nobody", null)]);
    assert.equal(r.byAccount.get("a1")?.[0].confidence, "high");
    assert.equal(r.byAccount.get("a2")?.[0].method, "name");
    assert.deepEqual(r.ambiguous.map((x) => x.customerId), ["c3"]);
    assert.equal(r.byAccount.get("a6")?.[0].confidence, "low");
    assert.deepEqual(r.unmatched.map((x) => x.customerId), ["c5"]);
  });
});

// ---------------- signals ----------------
describe("signals", () => {
  test("usage trend uses 28-day windows and ignores small baselines", () => {
    assert.ok(ids(facts({ usage: summariseUsage([tenant(50, 100)], AS_OF) })).includes("usage_drop"));
    assert.ok(ids(facts({ usage: summariseUsage([tenant(150, 100)], AS_OF) })).includes("usage_growth"));
    assert.ok(!ids(facts({ usage: summariseUsage([tenant(100, 100)], AS_OF) })).some((i) => i.startsWith("usage_")));
    assert.ok(!ids(facts({ usage: summariseUsage([tenant(5, 10)], AS_OF) })).some((i) => i.startsWith("usage_"))); // tiny baseline
  });

  test("pilot with an open deal but zero production usage is a risk", () => {
    const f = facts({
      account: { id: "acc_100", name: "Pilot Co", stage: "mvp", createdAt: "", updatedAt: "", lastContactAt: "2025-03-10" },
      opportunities: [{ id: "o1", accountId: "acc_100", stage: "mvp", status: "open", value: 1_000_000, nextStep: "x" }],
      usage: summariseUsage([tenant(0, 0)], AS_OF),
    });
    assert.ok(ids(f).includes("pilot_not_adopted"));
  });

  test("inbound email is 'awaiting reply' unless an outbound email or meeting follows", () => {
    const inbound = { id: "e1", accountId: "acc_100", type: "email" as const, direction: "inbound" as const, timestamp: "2025-03-10T08:00:00Z" };
    const reply = { id: "e2", accountId: "acc_100", type: "email" as const, direction: "outbound" as const, timestamp: "2025-03-11T08:00:00Z" };
    assert.ok(ids(facts({ activities: [inbound] })).includes("awaiting_reply"));
    assert.ok(ids(facts({ activities: [reply, inbound] })).includes("inbound_followed_up"));
  });

  test("low balance is growth when usage holds, risk when usage falls", () => {
    const alert = { alert: "Low credit balance", alertType: "low_credit_balance_reached", threshold: 0.15, createdAt: "2025-03-10T08:00:00Z" };
    const kind = (r: number, p: number) => computeSignals(facts({ usage: summariseUsage([tenant(r, p, { alerts: [alert] })], AS_OF) }), AS_OF).find((s) => s.id === "alert_balance")?.kind;
    assert.equal(kind(100, 100), "growth");
    assert.equal(kind(50, 100), "risk");
  });
});

// ---------------- grounding & actions ----------------
describe("grounding and actions", () => {
  test("parses ACTION lines and drops actions on unseen accounts", () => {
    const { text, actions } = extractActions("Call them.\nACTION: task | acc_001 | Call CFO | 2025-03-17\nACTION: note | acc_999 | invented", new Set(["acc_001"]));
    assert.equal(text, "Call them.");
    assert.deepEqual(actions, [{ type: "task", accountId: "acc_001", title: "Call CFO", dueDate: "2025-03-17" }]);
  });
  test("warns on account ids that were not in the facts", () => {
    assert.equal(groundingWarnings("see [acc_001] and [acc_777]", "[acc_001] ...").length, 1);
    assert.equal(groundingWarnings("see [acc_001]", "[acc_001] ...").length, 0);
  });
  test("action selection accepts lists, 'all' and nothing", () => {
    assert.deepEqual(parseSelection("1,3", 3), [0, 2]);
    assert.deepEqual(parseSelection("all", 2), [0, 1]);
    assert.deepEqual(parseSelection("", 3), []);
    assert.deepEqual(parseSelection("9, x", 3), []);
  });
});

// ---------------- end to end ----------------
describe("end to end (real analytics + mock CRM, fake LLM)", () => {
  let snap: Snapshot;
  let close = () => {};

  before(async () => {
    let base = process.env.CRM_BASE_URL ?? "http://localhost:3001";
    try {
      const { CrmDb } = await import("../mock-crm/db.ts");
      const { createApp } = await import("../mock-crm/app.ts");
      const db = new CrmDb();
      const app = createApp(db);
      const server: Server = createServer(async (req, res) => {
        const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
        const out = await app.request(req.url!, { method: req.method, body: body || undefined, headers: { "content-type": "application/json" } });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(await out.text());
      });
      await new Promise<void>((r) => server.listen(0, r));
      base = `http://localhost:${(server.address() as { port: number }).port}`;
      close = () => { server.close(); db.close(); };
    } catch {
      /* mock CRM deps unavailable — use a CRM already running at CRM_BASE_URL */
    }
    snap = await buildSnapshot({ analyticsPath: ANALYTICS, crm: new CrmClient(base) });
  });
  after(() => close());

  test("snapshot covers the book, dated from the data", () => {
    assert.equal(snap.views.length, 200);
    assert.equal(snap.asOf, AS_OF);
    assert.ok(snap.join.byAccount.size > 150);
  });

  test("resolver: full names, partial names, ambiguity, unknowns and usage-only tenants", () => {
    assert.equal(resolve("what's going on with HearthPediatrics?", snap).accounts[0]?.account.id, "acc_001");
    assert.equal(resolve("hearth pediatrics", snap).accounts[0]?.account.id, "acc_001");
    assert.ok(resolve("tell me about Sage", snap).ambiguous.length === 1);
    assert.deepEqual(resolve("acc_999?", snap).unknownIds, ["acc_999"]);
    assert.ok(resolve("tell me about Zebracorp", snap).notFound.includes("Zebracorp"));
    assert.equal(resolve("how is graniteintegrated doing?", snap).orphans[0]?.customerName, "graniteintegrated-prod");
  });

  test("router: 'this week' is not a follow-up, 'there' is", () => {
    assert.equal(route("which accounts can I ignore this week?", snap, null, ["acc_001"]).followUp, false);
    const r = route("what should I do there?", snap, null, ["acc_001"]);
    assert.equal(r.followUp, true);
    assert.deepEqual(r.intents, ["account"]);
  });

  test("facts carry book totals, date gaps and related records", () => {
    const f = buildFacts(route("tell me about SageMedGroup", snap, null), snap);
    assert.match(f, /BOOK TOTALS/);
    assert.match(f, /Related CRM records: .*acc_014/);
    assert.match(buildFacts(route("tell me about HearthPediatrics", snap, null), snap), /contract_001 ends 9 days before opp_001 closes/);
  });

  test("ambiguous names are clarified without calling the model", async () => {
    let called = false;
    const t = await new Assistant(snap, async () => ((called = true), "x")).ask("tell me about Sage");
    assert.equal(called, false);
    assert.equal(t.clarification, true);
  });

  test("flags invented ids and falls back to facts when the model fails", async () => {
    const ok = await new Assistant(snap, async () => "Focus on [acc_001] and [acc_777].").ask("tell me about HearthPediatrics");
    assert.ok(ok.warnings.some((w) => w.includes("acc_777")));
    const failed = await new Assistant(snap, async () => { throw new Error("boom"); }).ask("what should I focus on today?");
    assert.equal(failed.usedLlm, false);
    assert.match(failed.answer, /TOP PRIORITIES/);
  });
});
