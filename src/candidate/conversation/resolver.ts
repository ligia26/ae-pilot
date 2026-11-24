/**
 * Finds which accounts a question is about, without the LLM.
 *
 *   1. explicit ids ("acc_001"), reporting unknown ones
 *   2. full company names / domains contained in the question ("HearthPediatrics", "hearth pediatrics")
 *   3. partial names by prefix ("Lakeview" -> LakeviewMen LLC + LakeviewMen Group)
 *        - one company        -> resolved (duplicate records of it included)
 *        - several companies  -> ambiguous, the AE is asked which one
 *   4. product usage with no CRM account ("graniteintegrated")
 * Capitalised words that match nothing are reported as not found, so the tool
 * can say so instead of silently answering about something else.
 */
import { crmNameStem, hostStem, norm } from "../domain/join.ts";
import type { AccountView } from "../domain/types.ts";
import type { OrphanUsage, Snapshot } from "../data/snapshot.ts";

export type Resolution = {
  accounts: AccountView[];
  ambiguous: Array<{ term: string; candidates: AccountView[] }>;
  orphans: OrphanUsage[];
  unknownIds: string[];
  notFound: string[];
};

const MAX_ACCOUNTS = 4;
const MIN_TOKEN = 4;
// Words that are too generic to identify a company, plus common question words.
const STOP = new Set(
  ("about account accounts what which where when with from have that this they them their there these those should would could " +
    "tell show give compare doing going happened last week month today focus risk risky growth grow ready renewal renew usage " +
    "customer customers deal deals pipeline status update latest call email note task help please also into than then " +
    "health healthcare medical care group clinic clinics clinical network partners family systems corp company inc ltd llc " +
    "ignore rules revenue corti").split(" "),
);

const stemsOf = (v: AccountView) => [crmNameStem(v.account.name), hostStem(v.account.domain)].filter((s): s is string => !!s && s.length >= MIN_TOKEN);

export function resolve(question: string, snap: Snapshot): Resolution {
  const res: Resolution = { accounts: [], ambiguous: [], orphans: [], unknownIds: [], notFound: [] };
  const add = (v: AccountView) => { if (!res.accounts.includes(v) && res.accounts.length < MAX_ACCOUNTS) res.accounts.push(v); };

  // 1. ids
  for (const [id] of question.matchAll(/acc_\d+/gi)) {
    const v = snap.byId.get(id.toLowerCase());
    v ? add(v) : res.unknownIds.push(id.toLowerCase());
  }

  // 2. full names: longest first, so "SageMedGroup Group - North" beats "SageMedGroup Group"
  const q = norm(question);
  const byLength = [...snap.views].sort((a, b) => crmNameStem(b.account.name).length - crmNameStem(a.account.name).length);
  for (const v of byLength) if (stemsOf(v).some((s) => q.includes(s))) add(v);

  // 3/4. partial names, one word (or two adjacent words) at a time
  const words = [...question.matchAll(/[A-Za-z][A-Za-z-]*/g)].map((m) => m[0]);
  const terms = [...words.map((w, i) => (i + 1 < words.length ? `${w} ${words[i + 1]}` : "")).filter(Boolean), ...words];
  const covered = (t: string) => res.accounts.some((v) => stemsOf(v).some((s) => s.startsWith(t)));
  for (const term of terms) {
    const t = norm(term);
    if (t.length < MIN_TOKEN || STOP.has(t) || covered(t)) continue;
    const isTwoWords = term.includes(" ");
    const cands = snap.views.filter((v) => stemsOf(v).some((s) => s.startsWith(t)));
    const orphans = snap.orphanUsage.filter((o) => o.stem.startsWith(t));
    res.orphans.push(...orphans.filter((o) => !res.orphans.includes(o)));

    const companies = new Set(cands.map((v) => crmNameStem(v.account.name)));
    if (cands.length && companies.size === 1) cands.forEach(add); // one company, maybe several duplicate records
    else if (cands.length > 1 && !isTwoWords && !res.ambiguous.some((a) => a.term === term)) res.ambiguous.push({ term, candidates: cands.slice(0, 8) });
    // Capitalised words (but not the sentence's first word) that match nothing look like names we don't know.
    else if (!cands.length && !orphans.length && !isTwoWords && /^[A-Z]/.test(term) && term !== words[0]) res.notFound.push(term);
  }
  // An ambiguous word is moot if another word in the question already pinned the account down.
  res.ambiguous = res.ambiguous.filter((a) => !a.candidates.some((c) => res.accounts.includes(c)));
  return res;
}
