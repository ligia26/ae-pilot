# AE Copilot: solution notes

A terminal chat tool that tells an AE what deserves attention today, and why. It combines the CRM (over HTTP) and product usage (SQLite). Deterministic code computes every fact and score; Corti Models only turns those facts into a short, cited answer.

## Run it

```bash
npm install
cp .env.example .env.local          # set CORTI_API_KEY
# analytics.sqlite is not in this repo (562 MB > GitHub's limit):
# copy it from the challenge zip to data/analytics/analytics.sqlite
npm run dev                          # terminal 1: mock CRM on :3001
npm run ae                           # terminal 2: the tool (same as `npm run challenge`)
npm test                             # starter tests + solution tests
```

**Corti auth.** Corti access tokens last about 5 minutes. The simplest setup is to put the client credentials in `.env.local` and add `CORTI_TOKEN_CMD="sh scripts/get-token.sh"`: the tool then fetches a new token before each call that needs one and retries once on a 401. A long-lived `CORTI_API_KEY` also works on its own, with no refresh.

Optional settings: `AE_OWNER=jordan.lee` (scope to one AE's book), `CORTI_MODEL=...`, `AS_OF=YYYY-MM-DD`, `NO_LLM=1` (facts only).

On start-up it loads everything (about 5 s) and prints the top 5 accounts. Then ask anything:

- "what should I focus on today?"
- "which customers are at risk?"
- "who's ready to expand?"
- "what happened last week?"
- "tell me about HearthPediatrics" → "what should I do there?"

Commands: `/owner <id|all>`, `/facts` (the exact facts behind the last answer), `/account <name>` (full dossier, no LLM), `/data` (join and data-quality report), `/reset`, `/help`.

When the model suggests a CRM action (a task or a note), the AE is asked to confirm it before anything is written.

## Approach

```
CRM HTTP API ──┐                         ┌─ signals (risk / growth / hygiene, with evidence)
               ├─ join (stems + confidence) ┤
analytics SQL ─┘                         └─ priority score + data-confidence per account
                                                    │
AE question → deterministic router → smallest relevant fact set → Corti Models → grounding check → answer + confirmable actions
```

1. **Snapshot.** One pass loads all 200 accounts and their contacts, activities, opportunities and tasks from the CRM API. It paginates, retries 429/5xx with backoff, and a failed endpoint degrades to "unknown" instead of crashing. Usage is aggregated per analytics customer in SQL. The book is small, so precomputing makes every answer fast and reproducible.
2. **Join** (`domain/join.ts`). The systems share no key, so each identifier is reduced to a normalised stem:
   - CRM domain;
   - analytics domain (`hearthpediatrics`, `Xcustomers.example`);
   - billing/owner email host;
   - names with legal suffixes (`Group`, `LLC`) and environment suffixes (`-prod`, `prod`, `-eu`, `-cloud`, `-trial`) removed.

   Matches are ranked **domain (high) > email domain (medium) > name (medium)**. Results: 188/200 accounts linked (143 at high confidence). The traps it handles:
   - **Duplicate CRM records** (e.g. LakeviewMen LLC and LakeviewMen Group share a domain). If exactly one record is live, usage is attributed to it at *low* confidence. If both are live, the usage is **not attributed** and is shown as ambiguous. I chose not to guess, because wrong usage on an account is worse for an AE than "unclear".
   - Several tenants per company (`crestlinechild-eu` / `-us`) are summed.
   - Duplicate analytics records are flagged.
   - An old billing domain (`pinnacleoutpatientold`) is flagged as a likely rebrand.
   - Sandbox tenants are excluded.
   - Usage with **no CRM account at all** (8 tenants, e.g. `graniteintegrated-prod`, about 4.5k requests in 28 days) is surfaced as unworked pipeline.
3. **Signals** (`domain/signals.ts`). Small explainable facts, each with its numbers and source system:

   | Kind | Signals |
   |---|---|
   | Risk | pilot/evaluation with an open deal but zero production usage, usage stopped (7d+), usage down ≥25% (28 days vs prior 28 days), contract renewal ≤90d, usage on an expired contract, negative meeting, concern in notes, no contact ≥30d, opportunity past close date or stalled ≥60d, single-threaded, low balance *while usage falls* |
   | Growth | usage up ≥25%, new capabilities (agents) adopted, low-balance / usage-spike alerts, contract balance ≤20% used up, opportunity closing ≤30d, inbound email awaiting reply (no outbound email/meeting since), production usage on a prospect/closed-lost account that is growing |
   | Hygiene | overdue tasks, opportunity without a next step, CRM stage contradicted by product usage, duplicate record, customer with no attributable usage |

   Usage means **production only, excluding NFR**. "Today" is **2025-03-14**, the last day of usage data; the wall clock would make everything look dead.
4. **Priority** = sum of risk weights + growth weights + a small boost for value at stake (open opportunity or live contract). The weights are hand-set and visible in the code, so the ranking can be explained line by line and tuned with sales.
5. **Conversation layer** (`conversation/`).
   - **Resolver** (no LLM): finds accounts by ID, full name, or partial name ("Lakeview"). If a name matches several companies, the tool asks which one instead of guessing. Unknown IDs and names are reported, and usage with no CRM account ("graniteintegrated") can be looked up.
   - **Router** (keyword intents): picks the facts. These are account details (with related duplicate and parent/child records), top priorities, risk, growth, a summary of the last 7 days (routine emails counted, not listed), hygiene, and "quiet" accounts that are safe to deprioritise. Quiet accounts with weak data confidence are listed separately, because missing data isn't the same as a quiet account. A follow-up like "what should I do there?" reuses the previous accounts; "this week" doesn't trigger that.
   - **Facts** include book-wide totals and pre-computed date gaps ("contract ends 9 days before the opportunity closes"), so the model never has to do arithmetic or claim "largest in the book" from a partial list. Each account carries its data-confidence level *and the reason for it*.
   - The model gets only those facts, each tagged with its account ID, source system and data-confidence level.
   - The system prompt (`prompt.ts`) requires citations as `[acc_xxx]`, a concrete next action, and a High/Medium/Low confidence (never High when the join is weak, CRM and usage disagree, or there's a single signal). It forbids attributing roles, intentions or opinions to people beyond the data; interpretations must be labelled. It tells the model who the AE is, or that the AE isn't set, so it never says "you own".
   - Suggested CRM actions are shown once as a numbered list; the AE picks which to save (`1,3`, `all`, or none).
   - `corti-s1` reasons before answering, so no token cap is sent by default. An empty completion is retried once, and an expired token is refreshed and retried.
   - After each answer, any cited account ID that wasn't in the supplied facts triggers a warning. Suggested actions on accounts the model wasn't shown are dropped.
   - If the LLM call fails, the tool prints the underlying facts, so the AE is never left with nothing.
   - Follow-up questions ("what should I do there?") reuse the accounts from the previous answer.

## How confidence is communicated

- **Per account:** the data-confidence level (HIGH/MEDIUM/LOW) and the reasons for it (match method, ambiguous or duplicate records, CRM fetch failures, missing contact dates).
- **Per claim:** every signal carries its numbers and its source system, so "usage declining" always arrives with "1,127 vs 1,567 requests (-28%)".
- **Per answer:** the model must state its confidence and why. `/facts` shows exactly what it was given, and `/data` shows join coverage and data gaps.

## Key assumptions

- One shared book of 200 accounts. "My accounts" is the CRM `ownerId`, chosen with `/owner` or `AE_OWNER`. Opportunity owners sometimes differ from account owners; I show both and don't reconcile them.
- "Today" is the latest usage date (2025-03-14), and both systems are read as of that date.
- Requests (summed `quantity` of `request` events) are the main adoption metric. Tokens and transcription minutes are loaded but not yet used for scoring.
- Contract `amount`/`balance` are in currency, while usage is in requests, so I don't compute a money run-rate. I rely on balance %, end dates and the platform's own low-balance alerts.
- Accounts the CRM marks prospect or closed_lost but which have growing production usage are treated as a stale CRM stage or unworked expansion. This pattern is common in the data (about 1 in 4 accounts), so it counts for little unless usage is growing.

## Tradeoffs

- **Rules over ML for scoring.** There's no labelled outcome data, and an AE needs to trust the "why". The cost: the weights are judgment calls.
- **Precompute everything.** This suits 200 accounts and gives consistent answers. At larger scale I'd sync incrementally into a store instead.
- **Keyword router instead of LLM tool-calling.** It's predictable, cheap and testable, and it doesn't depend on the model's function-calling support. The cost: unusual phrasings fall back to the "today" view. They still get grounded facts, just a broader set.
- **Exact stem matching, no fuzzy matching.** Fewer false joins. The cost: 12 accounts stay unlinked, and they're reported rather than guessed.
- **Terminal UI**, as UI polish wasn't in scope.

## What I'd do next

1. **Check every number in an answer, not just account IDs:** extract numbers and dates from the model's answer and confirm each appears in the facts it was given.
2. **Validate the weights with AEs.** Replay past weeks (as-of dates) and check whether flagged accounts actually churned or expanded, then tune the thresholds.
3. **LLM tool-calling** (`get_account`, `rank_book`, `events`) so the model can make follow-up queries, keeping the same grounding check. Also check every number in the answer against the facts, not just account IDs.
4. **Better join:** a reviewed mapping table (with human confirmation) for the ambiguous and duplicate cases, and a CRM data-quality queue to merge duplicates.
5. **Richer usage signals:** tokens and transcription per contract unit, per-project and per-key trends (e.g. a single integration going quiet), seasonality-aware baselines instead of a 28-day comparison.
6. **Deliver it where AEs work:** a Slack or daily-digest version of the top 5, with write-backs to the CRM.
7. **Evaluation:** a set of AE questions with expected cited accounts, run on every prompt change.

## Layout

```
src/candidate/
  index.ts                  wiring only: CRM check, snapshot, LLM connect, REPL
  data/
    crm-client.ts           HTTP client: pagination, retries, timeouts, graceful degradation
    analytics.ts            SQL aggregations (production only, NFR excluded, weekly windows)
    snapshot.ts             load both systems -> join -> signals -> scores, once at start-up
  domain/                   pure logic, no I/O
    types.ts                shared types
    join.ts                 CRM <-> analytics matching with confidence
    related.ts              duplicate and parent/child CRM records
    usage.ts                roll tenants up into one usage summary per account
    signals.ts              signal rules (one small function per rule)
    scoring.ts              priority, value at stake, data confidence + reasons
    events.ts               last-N-days summary across both systems
    format.ts               date/number helpers
  conversation/
    resolver.ts             which accounts a question is about (no LLM)
    router.ts               which views of the book a question needs
    facts.ts                formats the facts sent to the model
    prompt.ts               system prompt and grounding rules
    grounding.ts            post-checks: invented ids, ACTION parsing
    assistant.ts            one turn: route -> facts -> clarify | LLM -> checks
  llm/
    llm.ts                  Corti Models call (retries on empty / expired token)
    corti-auth.ts           static key, token command, or client-credentials refresh
  cli/
    repl.ts                 terminal loop
    commands.ts             slash commands
    actions.ts              numbered CRM action picker
    views.ts                start-up overview, /data report
tests/candidate.test.ts     join, signals, grounding, actions, resolver, router, facts, e2e
scripts/get-token.sh        prints a fresh Corti token (for CORTI_TOKEN_CMD)
```

Adding a signal means adding one rule to `RULES` in `domain/signals.ts`, and adding a view of the book means adding one entry to `SECTIONS` in `conversation/facts.ts` plus its intent in `router.ts`.
