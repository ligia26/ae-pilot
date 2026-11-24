/** Deterministic text views printed by the CLI (no LLM involved). */
import type { Snapshot } from "../data/snapshot.ts";
import { int } from "../domain/format.ts";

export function overview(s: Snapshot, owner: string | null): string {
  const scope = s.views.filter((v) => !owner || v.account.ownerId === owner);
  const lines = [
    `Data as of ${s.asOf} · ${scope.length} accounts${owner ? ` for ${owner}` : " (all owners)"} · ${s.join.byAccount.size}/${s.views.length} accounts linked to usage data`,
    "",
    "Top 5 by priority (risk + growth + value at stake):",
    ...scope.slice(0, 5).map((v, i) => {
      const reasons = v.signals.filter((x) => x.kind !== "hygiene").sort((a, b) => b.weight - a.weight).slice(0, 2).map((x) => x.label.toLowerCase());
      return `  ${i + 1}. [${v.account.id}] ${v.account.name} (${v.account.stage}) — ${reasons.join("; ") || "hygiene only"} · confidence ${v.confidence}`;
    }),
  ];
  if (s.crmFailures.length) lines.push(`\n⚠ ${s.crmFailures.length} CRM requests failed; affected accounts are marked low confidence.`);
  return lines.join("\n");
}

export function dataReport(s: Snapshot): string {
  const methods = new Map<string, number>();
  for (const ms of s.join.byAccount.values()) for (const m of ms) methods.set(`${m.method}/${m.confidence}`, (methods.get(`${m.method}/${m.confidence}`) ?? 0) + 1);
  const ambiguous = [...new Map(s.join.ambiguous.map((a) => [a.customerName, a])).values()];
  return [
    `Accounts linked to usage: ${s.join.byAccount.size}/${s.views.length}`,
    `Match methods: ${[...methods].map(([k, n]) => `${k}=${n}`).join(", ")}`,
    `Ambiguous (not attributed): ${ambiguous.map((a) => `${a.customerName} -> ${a.candidates.join("/")}`).join("; ") || "none"}`,
    `Likely duplicate CRM records: ${s.join.crmDuplicates.map((g) => g.join("+")).join("; ") || "none"}`,
    `Usage with no CRM account: ${s.orphanUsage.map((u) => `${u.customerName} (${int(u.req28)} req/28d)`).join("; ") || "none"}`,
    `CRM request failures: ${s.crmFailures.length}`,
  ].join("\n");
}
