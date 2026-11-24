# AE Copilot

## Getting started

```bash
npm run dev   # Start the mock CRM
npm run ae    # Start the copilot
```

data/analytics/analytics.sqlite isn't committed (over GitHub's 100 MB limit); copy it in from the challenge zip.


## What I built

A terminal-based conversational tool that helps an AE prepare for standup and decide which accounts to focus on.

At startup, it loads data from both the CRM and the analytics database, scores the accounts and presents the five that need the most attention.

The AE can then ask questions in natural language about specific accounts, renewal risks, growth opportunities, recent changes or what can be deprioritised.

Each answer includes supporting evidence, a recommended action and a confidence level. The `/facts` command shows exactly what information was passed to the model.

## My approach

I started by thinking about what an AE actually needs when they have 30 minutes to prepare for standup: which accounts need attention, why, and what to do about them.

I decided to keep the analytical logic separate from the LLM. Account matching, usage trends, rankings and calculations are handled in code, while the model interprets the results and communicates them to the AE.

This makes the recommendations more consistent, explainable and easier to test.

## How it works

```
CRM API ─┐                                          ┌─ per-account signals with evidence
         ├─ snapshot ─ join (with confidence) ──────┤
SQLite ──┘                                          └─ risk / growth / priority + data confidence
                                                                   │
question ─ resolver ─ router ─ facts ─ Corti Models ─ grounding check ─ answer + CRM actions

```

### Data and account matching

At startup the tool loads all 200 CRM accounts with their contacts, activities, opportunities and tasks, plus usage aggregated in SQLite (about five seconds). The reference date is 14 March 2025, the last day of usage data. Only production usage counts; sandbox tenants and NFR events are excluded.

Accounts are matched on domain, then email domain, then normalised name, in order of reliability. Where usage fits several CRM records, it goes to the only active one at low confidence, or stays unattributed. I'd rather leave a gap than put usage on the wrong account.

Result: 188 of 200 accounts linked (143 by domain), plus 8 analytics-only tenants that can still be looked up.

### Commercial signals

I wanted the signals to reflect situations an AE could actually act on. Some examples:

- **Adoption:** production API requests over the last 28 days compared with the previous 28 days. I use requests rather than tokens because token consumption varies with note length. A minimum baseline of 200 requests avoids misleading percentage changes.
- **Balance:** low balance with stable usage suggests a top-up opportunity, while low balance with declining usage may indicate retention risk.
- **CRM and usage discrepancies:** CascadePartners has a $1M MVP opportunity but no usage for eight weeks, making it the second-highest priority. However, 49 of 62 prospect or closed-lost accounts show usage, so I only increase their priority when usage is growing.
- **Engagement:** an inbound email is considered unanswered only if no subsequent outbound email or meeting is recorded.

Each signal carries its own evidence and data source.

### Prioritisation and confidence

Accounts are ranked using weighted commercial signals, with revenue and retention taking precedence over CRM hygiene.

| Signal                   | Weight    |
| ------------------------ | --------- |
| Usage stopped            | 4         |
| Renewal within 45 days   | 3         |
| Account value adjustment | Up to 2   |
| CRM hygiene              | Up to 0.5 |

The weights are based on my judgement rather than historical outcomes. I chose rules because they are transparent and can easily be adjusted with feedback from the sales team.

I also distinguish between two types of confidence:

- **Data confidence:** match reliability, ambiguity and missing data.
- **Answer confidence:** how strongly the available evidence supports the recommendation.

The model is instructed not to assign high confidence when the data is weak, the systems disagree or there is only one supporting signal.

### Conversation

The resolver identifies accounts by ID, full name or partial name and asks for clarification when necessary, without calling the model.

The router selects the relevant information based on the question, including account details, risk, growth, recent activity, priorities and accounts that can be deprioritised.

The model receives pre-computed facts rather than raw tables. It is instructed to cite evidence, distinguish facts from interpretations and avoid guessing.

A grounding check flags account IDs that were not included in the supplied facts. CRM writes require explicit confirmation from the AE.

## Architecture

```
src/candidate/
  data/           CRM client, SQL aggregations, snapshot
  domain/         Matching, usage, signals, scoring
  conversation/   Resolver, router, facts, prompt, grounding
  llm/            Corti Models and token management
  cli/            Terminal interface and action confirmation

```

The domain layer consists of pure functions, independent of the database, network and system clock. This makes the business logic easy to test and allows the reference date to be configured through `AS_OF`.

Signals are implemented as individual rules in `domain/signals.ts`, making it straightforward to add or adjust commercial signals. The conversation layer follows a similar approach through the `SECTIONS` registry in `conversation/facts.ts`.

Dependencies are injected so the assistant can be tested with a fake LLM and the snapshot builder with the mock CRM.

The CRM client handles pagination, timeouts, exponential backoff on rate limits and server errors, and bounded concurrency of eight requests. Individual account request failures reduce data confidence rather than stopping the entire application.

Analytics aggregation happens directly in SQLite, avoiding loading the 2.2 million usage rows into application memory.

The assistant is independent of the terminal, so a Slack integration or HTTP endpoint could reuse the same logic.

## Testing and validation

Automated tests in `tests/candidate.test.ts` cover matching, signals, grounding, action parsing and end-to-end flows against the mock CRM and analytics database, using a fake LLM.

I also tested the conversational layer against the live model, including unknown and ambiguous accounts, follow-up questions, prompt injection and questions that could not be answered from the data.

Some issues I encountered and addressed:

| Issue                                               | Fix                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Model guessed contacts' roles                       | Provided titles and personas explicitly and instructed the model not to infer missing roles |
| Model performed date calculations                   | Pre-computed date differences                                                               |
| "This week" was interpreted as an account follow-up | Narrowed follow-up detection                                                                |
| Reasoning exhausted the token budget                | Removed the explicit cap, added a retry and a fallback to the underlying facts              |

## Assumptions

- Production API requests are the best available measure of adoption.
- An AE's book is determined by CRM account ownership (`/owner jordan.lee`). Opportunity owners may differ, so both are shown.
- Contract values and API requests represent different units, so I rely on balance percentages, contract dates and platform alerts rather than calculating a monetary burn rate.

## Trade-offs

- **Rule-based scoring:** explainable and easy to adjust, but the weights need validation against commercial outcomes.
- **Conservative matching:** reduces incorrect attribution but leaves 12 accounts unlinked.
- **Deterministic routing over tool calling:** predictable and testable, although unusual questions may receive broader context than necessary.
- **Full startup load:** appropriate for 200 accounts, but not ideal at scale.
- **CLI:** allowed me to focus on the quality of the recommendations rather than frontend development.

## What I would improve with more time

- **Conversational evaluation:** create a fixed set of AE questions with assertions on which accounts should and should not be referenced, expected confidence levels and fallback responses. Run these whenever the prompt or model changes.
- **Number-level grounding:** extend the existing account ID checks to validate figures and dates against the facts supplied to the model, catching unsupported numerical claims before they reach the AE.
- **Back-testing the scoring:** extend `AS_OF` filtering to CRM activities, replay historical account data and calibrate signal weights against actual commercial outcomes.
- **Tool calling:** expose `get_account`, `rank` and `events` as tools so the model can retrieve specific information for complex follow-up questions rather than relying on broader context.
- **Account matching:** use name similarity to identify potential matches for the 12 unlinked accounts and store manually confirmed matches in a mapping table, avoiding repeated resolution.
- **Incremental synchronisation:** replace the full startup load with a cached snapshot, refreshing changed records based on `updatedAt` and activity timestamps.
