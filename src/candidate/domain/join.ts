/**
 * Joining CRM accounts to analytics customers.
 *
 * The two systems share no key. What they do share, imperfectly:
 *   - CRM `domain` ("hearthpediatrics.example", sometimes missing)
 *   - analytics `domain` ("hearthpediatrics", sometimes missing, sometimes "Xcustomers.example")
 *   - analytics billing/owner email hosts ("billing@hearthpediatrics.example")
 *   - names ("HearthPediatrics Group" vs "hearthpediatrics-prod" / "hearthpediatricsprod")
 *
 * Strategy: reduce every identifier to a normalised "stem", then match on stem
 * equality with a method-ranked confidence. We never fuzzy-guess beyond that:
 * an analytics customer that matches several CRM accounts equally well is left
 * unattributed and reported as ambiguous, because silently attributing usage to
 * the wrong account is worse for an AE than saying "we're not sure".
 */

export type MatchMethod = "domain" | "email_domain" | "name";
export type MatchConfidence = "high" | "medium" | "low";

export type CrmAccountLite = { id: string; name: string; domain?: string | null; stage?: string; updatedAt?: string };
export type AnalyticsCustomerLite = {
  id: string;
  customer_name: string;
  domain: string | null;
  billing_email: string | null;
  owner_email: string | null;
  environment_type: string;
};

export type CustomerMatch = {
  customerId: string;
  customerName: string;
  accountId: string;
  method: MatchMethod;
  confidence: MatchConfidence;
  environment: string;
  note?: string;
};

export type JoinResult = {
  /** accountId -> matched analytics customers */
  byAccount: Map<string, CustomerMatch[]>;
  /** analytics customers that matched >1 CRM account with equal strength */
  ambiguous: Array<{ customerId: string; customerName: string; candidates: string[]; method: MatchMethod }>;
  /** analytics customers with no CRM account at all */
  unmatched: Array<{ customerId: string; customerName: string }>;
  /** CRM accounts that look like duplicates of each other (same domain or name stem) */
  crmDuplicates: string[][];
  /** possible parent/child relations (e.g. "sagemedgroup-holdings" vs "SageMedGroup Group - North") — informational only */
  possibleParents: Array<{ customerId: string; customerName: string; accountIds: string[] }>;
};

const LEGAL_WORDS = /\b(group|llc|ltd|inc|healthcare|co|corp|corporation|plc)\b/g;
// Environment / deployment suffixes seen in analytics customer names.
const NAME_SUFFIXES = [
  "-health-group",
  "-holdings",
  "-sandbox",
  "-trial",
  "-cloud",
  "-prod",
  "-eu",
  "-us",
  "prod",
];

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hostStem(hostOrDomain: string | null | undefined): string | null {
  if (!hostOrDomain) return null;
  let h = hostOrDomain.toLowerCase().trim();
  if (h.includes("@")) h = h.split("@")[1];
  h = h.replace(/\.example$/, "").replace(/\.(com|org|net|io)$/, "");
  // "acmetelemedicinecustomers" is a customer-facing tenant domain of acmetelemedicine
  h = h.replace(/customers$/, "");
  return norm(h) || null;
}

export function crmNameStem(name: string): string {
  return norm(name.toLowerCase().replace(LEGAL_WORDS, " "));
}

export function analyticsNameStem(name: string): string {
  let n = name.toLowerCase();
  for (const suf of NAME_SUFFIXES) {
    if (n.endsWith(suf) && n.length > suf.length + 3) {
      n = n.slice(0, -suf.length);
      break;
    }
  }
  return norm(n);
}

const RANK: Record<MatchMethod, number> = { domain: 3, email_domain: 2, name: 1 };
const CONFIDENCE: Record<MatchMethod, MatchConfidence> = { domain: "high", email_domain: "medium", name: "medium" };

export function joinAccounts(accounts: CrmAccountLite[], customers: AnalyticsCustomerLite[]): JoinResult {
  const byDomain = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string | null, v: string) => {
    if (!k) return;
    const arr = m.get(k) ?? [];
    if (!arr.includes(v)) arr.push(v);
    m.set(k, arr);
  };
  for (const a of accounts) {
    push(byDomain, hostStem(a.domain), a.id);
    push(byName, crmNameStem(a.name), a.id);
  }

  const result: JoinResult = { byAccount: new Map(), ambiguous: [], unmatched: [], possibleParents: [], crmDuplicates: [] };
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const group of [...byDomain.values(), ...byName.values()]) {
    if (group.length < 2) continue;
    const key = [...group].sort().join(",");
    if (!seen.has(key)) { seen.add(key); result.crmDuplicates.push([...group].sort()); }
  }

  for (const c of customers) {
    const dStem = hostStem(c.domain);
    const emailStems = [hostStem(c.billing_email), hostStem(c.owner_email)].filter(Boolean) as string[];
    const nStem = analyticsNameStem(c.customer_name);

    // Collect candidates per method. CRM accounts without a domain can only be
    // reached via their name stem, so analytics domain/email stems are also
    // tried against CRM name stems (at "name" strength).
    const cands: Array<{ accountId: string; method: MatchMethod }> = [];
    for (const id of dStem ? byDomain.get(dStem) ?? [] : []) cands.push({ accountId: id, method: "domain" });
    for (const s of emailStems) for (const id of byDomain.get(s) ?? []) cands.push({ accountId: id, method: "email_domain" });
    for (const s of new Set([nStem, dStem, ...emailStems].filter(Boolean) as string[]))
      for (const id of byName.get(s) ?? []) cands.push({ accountId: id, method: "name" });

    if (cands.length === 0) {
      const prefix = dStem ?? nStem;
      const children = accounts.filter((a) => (hostStem(a.domain) ?? crmNameStem(a.name)).startsWith(prefix) && prefix.length >= 6);
      if (children.length) result.possibleParents.push({ customerId: c.id, customerName: c.customer_name, accountIds: children.map((a) => a.id) });
      result.unmatched.push({ customerId: c.id, customerName: c.customer_name });
      continue;
    }

    const best = Math.max(...cands.map((x) => RANK[x.method]));
    const top = [...new Set(cands.filter((x) => RANK[x.method] === best).map((x) => x.accountId))];
    const method = cands.find((x) => RANK[x.method] === best)!.method;
    let chosen = top[0];
    let tieNote: string | undefined;
    if (top.length > 1) {
      // Duplicate CRM records. If exactly one is a live record (active stage),
      // attribute usage there at low confidence; otherwise refuse to guess.
      const ACTIVE = new Set(["customer", "mvp", "evaluation"]);
      const live = top.filter((id) => ACTIVE.has(acctById.get(id)?.stage ?? ""));
      if (live.length !== 1) {
        result.ambiguous.push({ customerId: c.id, customerName: c.customer_name, candidates: top, method });
        continue;
      }
      chosen = live[0];
      tieNote = `also matches duplicate CRM record(s) ${top.filter((x) => x !== chosen).join(", ")}; attributed to the only active one`;
    }

    let confidence: MatchConfidence = tieNote ? "low" : CONFIDENCE[method];
    let note: string | undefined = tieNote;
    const rebrand = emailStems.find((s) => s.endsWith("old"));
    const add = (n: string) => (note = [note, n].filter(Boolean).join("; "));
    if (rebrand) add(`billing/owner email uses an old domain (${rebrand}) — likely rebrand`);
    if (/-trial$/.test(c.customer_name)) add("trial tenant");
    if (c.environment_type !== "PRODUCTION") add("sandbox tenant (usage excluded)");
    const m: CustomerMatch = { customerId: c.id, customerName: c.customer_name, accountId: chosen, method, confidence, environment: c.environment_type, note };
    const arr = result.byAccount.get(chosen) ?? [];
    arr.push(m);
    result.byAccount.set(chosen, arr);
  }

  // Several analytics customers on one account is normal (eu/us, prod+trial) but
  // two identically named ones is a likely duplicate record — lower confidence.
  for (const arr of result.byAccount.values()) {
    const names = arr.map((m) => m.customerName);
    for (const m of arr) {
      if (names.filter((n) => n === m.customerName).length > 1) {
        m.confidence = m.confidence === "high" ? "medium" : "low";
        m.note = [m.note, "duplicate analytics record with identical name — usage summed, verify"].filter(Boolean).join("; ");
      }
    }
  }
  return result;
}
