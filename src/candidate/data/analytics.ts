/**
 * Analytics (product usage & consumption) access: read-only SQL, aggregated per
 * analytics tenant. Conventions applied in every query:
 *   - only PRODUCTION usage counts (sandbox is testing, not adoption)
 *   - NFR (not-for-resale / internal test) events are excluded
 *   - weeks are counted back from the as-of date (week 0 = last 7 days)
 */
import Database from "better-sqlite3";
import type { AnalyticsCustomerLite } from "../domain/join.ts";
import type { CustomerUsage } from "../domain/types.ts";

export const WEEKS = 12;
const PROD = "is_nfr = 0 AND environment_type = 'PRODUCTION'";

export class Analytics {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  close(): void {
    this.db.close();
  }

  /** The data is a snapshot: "today" is the last day with usage, not the wall clock. */
  latestEventDate(): string {
    return (this.db.prepare("SELECT MAX(event_date) d FROM usage_events").get() as { d: string }).d;
  }

  customers(): AnalyticsCustomerLite[] {
    return this.db
      .prepare("SELECT id, customer_name, domain, billing_email, owner_email, environment_type FROM customers WHERE archived_at IS NULL")
      .all() as AnalyticsCustomerLite[];
  }

  usage(asOf: string): Map<string, CustomerUsage> {
    const out = new Map<string, CustomerUsage>();
    const get = (id: string): CustomerUsage => {
      let u = out.get(id);
      if (!u) {
        u = { customerId: id, weekly: { requests: Array(WEEKS).fill(0), tokens: Array(WEEKS).fill(0), transcribe: Array(WEEKS).fill(0) }, lastEventDate: null, agentsRecent: [], agentsPrior: [], activeKeys: 0, keysUsedLast14d: 0, contracts: [], alerts: [] };
        out.set(id, u);
      }
      return u;
    };
    // Bind @asOf only where the query uses it (SQLite drivers reject unused named parameters).
    const rows = <T>(sql: string) => (sql.includes("@asOf") ? this.db.prepare(sql).all({ asOf }) : this.db.prepare(sql).all()) as T[];

    for (const r of rows<{ customer_id: string; event_type: string; wk: number; q: number }>(
      `SELECT customer_id, event_type, CAST((julianday(@asOf) - julianday(event_date)) / 7 AS INTEGER) wk, SUM(quantity) q
         FROM usage_events WHERE ${PROD} AND event_date <= @asOf AND event_date > date(@asOf, '-${WEEKS * 7} day')
        GROUP BY customer_id, event_type, wk`,
    )) {
      const key = ({ request: "requests", tokens: "tokens", transcribe: "transcribe" } as const)[r.event_type as "request" | "tokens" | "transcribe"];
      if (key && r.wk >= 0 && r.wk < WEEKS) get(r.customer_id).weekly[key][r.wk] += r.q;
    }

    for (const r of rows<{ customer_id: string; d: string }>(`SELECT customer_id, MAX(event_date) d FROM usage_events WHERE ${PROD} AND event_date <= @asOf GROUP BY customer_id`))
      get(r.customer_id).lastEventDate = r.d;

    for (const r of rows<{ customer_id: string; period: string; agent_used: string | null }>(
      `SELECT customer_id, CASE WHEN event_date > date(@asOf, '-28 day') THEN 'recent' ELSE 'prior' END period, agent_used
         FROM usage_events WHERE ${PROD} AND event_date <= @asOf AND event_date > date(@asOf, '-56 day') AND agent_used IS NOT NULL AND agent_used <> ''
        GROUP BY customer_id, period, agent_used`,
    ))
      (r.period === "recent" ? get(r.customer_id).agentsRecent : get(r.customer_id).agentsPrior).push(r.agent_used!);

    for (const r of rows<{ customer_id: string; active: number; used14: number }>(
      `SELECT customer_id, SUM(active) active, SUM(CASE WHEN active = 1 AND last_used_at >= date(@asOf, '-14 day') THEN 1 ELSE 0 END) used14
         FROM api_keys WHERE environment_type = 'PRODUCTION' GROUP BY customer_id`,
    ))
      Object.assign(get(r.customer_id), { activeKeys: r.active ?? 0, keysUsedLast14d: r.used14 ?? 0 });

    for (const { customer_id, ...c } of rows<CustomerUsage["contracts"][number] & { customer_id: string }>("SELECT * FROM contracts")) get(customer_id).contracts.push(c);

    for (const a of rows<{ customer_id: string; name: string; alert_type: string; threshold: number | null; created_at: string }>(
      `SELECT h.customer_id, a.name, a.alert_type, a.threshold, h.created_at
         FROM customer_alert_history h JOIN alerts a ON a.id = h.alert_id
        WHERE h.alert_status = 'triggered' AND h.created_at >= date(@asOf, '-30 day') AND h.created_at <= date(@asOf, '+1 day')
        ORDER BY h.created_at DESC`,
    ))
      get(a.customer_id).alerts.push({ alert: a.name, alertType: a.alert_type, threshold: a.threshold, createdAt: a.created_at });

    return out;
  }
}
