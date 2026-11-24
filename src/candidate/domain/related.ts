/**
 * CRM accounts that refer to the same company (duplicates: same domain or name stem)
 * or to a parent/child (one stem is a prefix of the other, e.g. "sagemedgroup" vs
 * "sagemedgroupnorth"). Informational: shown to the AE, never used to move usage around.
 */
import { crmNameStem, hostStem, type CrmAccountLite } from "./join.ts";
import type { MatchInfo } from "./types.ts";

const MIN_PREFIX = 6;

export function relatedAccounts(accounts: CrmAccountLite[], duplicateGroups: string[][]): Map<string, MatchInfo["related"]> {
  const out = new Map<string, MatchInfo["related"]>();
  const add = (a: string, b: string, relation: "duplicate" | "parent/child") => {
    const list = out.get(a) ?? [];
    if (a !== b && !list.some((r) => r.id === b)) list.push({ id: b, relation });
    out.set(a, list);
  };
  for (const group of duplicateGroups) for (const a of group) for (const b of group) add(a, b, "duplicate");

  const stems = accounts.map((a) => ({ id: a.id, stems: [hostStem(a.domain), crmNameStem(a.name)].filter((s): s is string => !!s) }));
  for (const x of stems)
    for (const y of stems)
      if (x.id !== y.id && x.stems.some((s) => s.length >= MIN_PREFIX && y.stems.some((t) => t !== s && t.startsWith(s)))) {
        add(x.id, y.id, "parent/child");
        add(y.id, x.id, "parent/child");
      }
  return out;
}
