/** Small, pure date and number helpers shared by signals and fact formatting. */
const DAY = 86_400_000;

/** Whole days from `from` to `to` (ISO dates or timestamps); positive when `to` is later. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY);

export const pctChange = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

export const int = (n: number): string => Math.round(n).toLocaleString("en-US");
export const money = (n: number | null | undefined): string => (n ? `$${int(Math.round(n / 1000))}k` : "n/a");
export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "?");
export const signed = (n: number | null): string => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`);

export const ACTIVE_STAGES: ReadonlySet<string> = new Set(["customer", "mvp", "evaluation"]);
export const isOpen = (o: { status?: string }): boolean => (o.status ?? "open") === "open";
