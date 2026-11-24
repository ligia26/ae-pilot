/** Shared domain types. No logic lives here. */
import type { Account, Activity, Contact, Opportunity, Task } from "../../../mock-crm/schema.ts";
import type { CustomerMatch, MatchConfidence } from "./join.ts";

export type { Account, Activity, Contact, Opportunity, Task };

// ---- analytics ----
export type WeeklyUsage = { requests: number[]; tokens: number[]; transcribe: number[] }; // index 0 = most recent week
export type Contract = { id: string; name: string | null; type: string; amount: number | null; balance: number | null; starting_at: string | null; ending_before: string | null };
export type AlertHit = { alert: string; alertType: string; threshold: number | null; createdAt: string };

export type CustomerUsage = {
  customerId: string;
  weekly: WeeklyUsage;
  lastEventDate: string | null;
  agentsRecent: string[]; // last 28 days
  agentsPrior: string[]; // 28–56 days ago
  activeKeys: number;
  keysUsedLast14d: number;
  contracts: Contract[];
  alerts: AlertHit[];
};

/** Usage of all production tenants matched to one CRM account, rolled up. */
export type UsageSummary = {
  weeklyRequests: number[];
  req28: number;
  reqPrior28: number;
  changePct: number | null;
  wowPct: number | null;
  lastEventDate: string | null;
  daysSinceUsage: number | null;
  agentsRecent: string[];
  agentsNew: string[];
  agentsDropped: string[];
  activeKeys: number;
  keysUsedLast14d: number;
  contracts: Array<Contract & { pctRemaining: number | null; daysToEnd: number | null }>;
  alerts: AlertHit[];
};

// ---- join ----
export type MatchInfo = {
  status: "matched" | "ambiguous" | "none";
  confidence: MatchConfidence | "none";
  customers: CustomerMatch[];
  ambiguousWith: Array<{ customerName: string; candidates: string[] }>;
  /** Other CRM accounts that look like the same company or its parent/children. */
  related: Array<{ id: string; relation: "duplicate" | "parent/child" }>;
};

// ---- signals ----
export type SignalKind = "risk" | "growth" | "hygiene";
export type Signal = {
  id: string;
  kind: SignalKind;
  weight: number;
  label: string;
  evidence: string;
  source: "crm" | "analytics" | "join";
};

/** Everything known about one account, before scoring. */
export type AccountFacts = {
  account: Account;
  contacts: Contact[];
  activities: Activity[];
  opportunities: Opportunity[];
  tasks: Task[];
  crmGaps: boolean;
  usage: UsageSummary | null;
  match: MatchInfo;
};

export type Confidence = "high" | "medium" | "low";

export type AccountView = AccountFacts & {
  signals: Signal[];
  risk: number;
  growth: number;
  hygiene: number;
  value: number;
  priority: number;
  confidence: Confidence;
  confidenceReasons: string[];
};
