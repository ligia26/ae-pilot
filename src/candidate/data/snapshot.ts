/**
 * Builds one in-memory snapshot of the whole book at start-up:
 * CRM (HTTP) + analytics (SQL) -> join -> signals -> scores, sorted by priority.
 * 200 accounts is small, so precomputing keeps answers fast and reproducible.
 */
import { analyticsNameStem, joinAccounts, type JoinResult } from "../domain/join.ts";
import { relatedAccounts } from "../domain/related.ts";
import { score } from "../domain/scoring.ts";
import { computeSignals } from "../domain/signals.ts";
import type { AccountFacts, AccountView, CustomerUsage, MatchInfo } from "../domain/types.ts";
import { summariseUsage } from "../domain/usage.ts";
import { Analytics } from "./analytics.ts";
import { CrmClient, mapLimit } from "./crm-client.ts";

/** Product usage from an analytics tenant that has no CRM account at all. */
export type OrphanUsage = { customerId: string; customerName: string; stem: string; req28: number; changePct: number | null };

export type Snapshot = {
  asOf: string;
  views: AccountView[]; // sorted by priority, highest first
  byId: Map<string, AccountView>;
  owners: string[];
  join: JoinResult;
  orphanUsage: OrphanUsage[];
  crmFailures: string[];
};

export type BuildOptions = { analyticsPath: string; crm?: CrmClient; asOf?: string; onProgress?: (msg: string) => void };

export async function buildSnapshot(opts: BuildOptions): Promise<Snapshot> {
  const log = opts.onProgress ?? (() => {});
  const crm = opts.crm ?? new CrmClient();
  const analytics = new Analytics(opts.analyticsPath);
  try {
    const asOf = opts.asOf ?? process.env.AS_OF ?? analytics.latestEventDate();
    log(`Loading CRM accounts from ${crm.baseUrl} ...`);
    const accounts = await crm.listAccounts();
    log(`Loading CRM detail for ${accounts.length} accounts ...`);
    const details = await mapLimit(accounts, 8, (a) => crm.accountDetail(a.id));
    log(`Aggregating product usage as of ${asOf} ...`);
    const usage = analytics.usage(asOf);
    const customers = analytics.customers();
    const join = joinAccounts(accounts, customers);
    const related = relatedAccounts(accounts, join.crmDuplicates);

    const views = accounts.map((account, i): AccountView => {
      const matches = join.byAccount.get(account.id) ?? [];
      const tenants = matches.filter((m) => m.environment === "PRODUCTION").map((m) => usage.get(m.customerId)).filter((u): u is CustomerUsage => !!u);
      const ambiguousWith = [...new Map(join.ambiguous.filter((x) => x.candidates.includes(account.id)).map((x) => [x.customerName, { customerName: x.customerName, candidates: x.candidates }])).values()];
      const match: MatchInfo = {
        status: matches.length ? "matched" : ambiguousWith.length ? "ambiguous" : "none",
        confidence: !matches.length ? "none" : matches.some((m) => m.confidence === "low") ? "low" : matches.some((m) => m.confidence === "medium") ? "medium" : "high",
        customers: matches,
        ambiguousWith,
        related: related.get(account.id) ?? [],
      };
      const { gaps, ...crmDetail } = details[i];
      const facts: AccountFacts = { account, ...crmDetail, crmGaps: gaps, usage: summariseUsage(tenants, asOf), match };
      return score(facts, computeSignals(facts, asOf));
    });
    views.sort((a, b) => b.priority - a.priority);

    const byName = new Map(customers.map((c) => [c.id, c]));
    const orphanUsage = join.unmatched
      .map(({ customerId, customerName }) => {
        const s = summariseUsage(usage.has(customerId) ? [usage.get(customerId)!] : [], asOf);
        return { customerId, customerName, stem: analyticsNameStem(byName.get(customerId)?.customer_name ?? customerName), req28: s?.req28 ?? 0, changePct: s?.changePct ?? null };
      })
      .sort((a, b) => b.req28 - a.req28);

    return {
      asOf,
      views,
      byId: new Map(views.map((v) => [v.account.id, v])),
      owners: [...new Set(accounts.map((a) => a.ownerId).filter((o): o is string => !!o))].sort(),
      join,
      orphanUsage,
      crmFailures: crm.failures,
    };
  } finally {
    analytics.close();
  }
}
