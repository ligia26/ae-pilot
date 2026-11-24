/**
 * CRM HTTP client. Treats the mock CRM like any external API:
 * paginates, times out, retries transient failures (429/5xx/network) with
 * backoff, and never assumes optional fields exist.
 */
import type { Account, Activity, Contact, Opportunity, Task } from "../domain/types.ts";

export type { Account, Activity, Contact, Opportunity, Task };

export class CrmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class CrmClient {
  /** Requests that ultimately failed — surfaced to the AE as data gaps. */
  readonly failures: string[] = [];

  constructor(
    readonly baseUrl = process.env.CRM_BASE_URL ?? `http://${process.env.CRM_HOST ?? "localhost"}:${process.env.CRM_PORT ?? 3001}`,
    private readonly retries = 3,
    private readonly timeoutMs = 10_000,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: ctrl.signal,
          headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        });
        if (res.ok) return (await res.json()) as T;
        const body = await res.json().catch(() => ({}));
        const err = new CrmError(`CRM ${init.method ?? "GET"} ${path} -> ${res.status} ${(body as { error?: string }).error ?? ""}`.trim(), res.status);
        if (res.status !== 429 && res.status < 500) throw err; // 4xx: don't retry
        lastErr = err;
      } catch (e) {
        if (e instanceof CrmError && e.status && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
      } finally {
        clearTimeout(t);
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    throw lastErr instanceof Error ? lastErr : new CrmError(String(lastErr));
  }

  /** Walks offset pagination until has_more is false. */
  private async all<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.req<Record<string, unknown>>(`${path}${sep}limit=100&offset=${offset}`);
      const items = (page[key] as T[] | undefined) ?? [];
      out.push(...items);
      const meta = page.meta as { has_more?: boolean; next_offset?: number | null } | undefined;
      if (!meta?.has_more || items.length === 0) break;
      offset = meta.next_offset ?? offset + items.length;
    }
    return out;
  }

  /** Wraps a fetch so one failing endpoint degrades to "unknown" instead of crashing. */
  private async safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<{ value: T; ok: boolean }> {
    try {
      return { value: await fn(), ok: true };
    } catch (e) {
      this.failures.push(`${label}: ${(e as Error).message}`);
      return { value: fallback, ok: false };
    }
  }

  health = () => this.req<{ ok: boolean }>("/health");
  listAccounts = () => this.all<Account>("/accounts", "accounts");
  getAccount = (id: string) => this.req<Account>(`/accounts/${encodeURIComponent(id)}`);

  async accountDetail(id: string) {
    const enc = encodeURIComponent(id);
    const [contacts, activities, opportunities, tasks] = await Promise.all([
      this.safe(`${id} contacts`, () => this.all<Contact>(`/accounts/${enc}/contacts`, "contacts"), []),
      this.safe(`${id} activities`, () => this.all<Activity>(`/accounts/${enc}/activities`, "activities"), []),
      this.safe(`${id} opportunities`, () => this.req<{ opportunities: Opportunity[] }>(`/accounts/${enc}/opportunities`).then((r) => r.opportunities ?? []), []),
      this.safe(`${id} tasks`, () => this.all<Task>(`/accounts/${enc}/tasks`, "tasks"), []),
    ]);
    const gaps = [contacts, activities, opportunities, tasks].some((x) => !x.ok);
    return { contacts: contacts.value, activities: activities.value, opportunities: opportunities.value, tasks: tasks.value, gaps };
  }

  addNote = (accountId: string, text: string) =>
    this.req<{ note: unknown }>(`/accounts/${encodeURIComponent(accountId)}/notes`, { method: "POST", body: JSON.stringify({ text }) });

  createTask = (accountId: string, title: string, dueDate?: string) =>
    this.req<{ task: unknown }>(`/tasks`, { method: "POST", body: JSON.stringify({ accountId, title, dueDate }) });
}

/** Run async work with bounded concurrency (be polite to the API). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}
