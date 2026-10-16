export interface Update {
  title: string;
  /** Local time, as the backend sends it: `2026/10/16 10:00`. */
  updatedAt: string;
}

const UPDATED_AT =
  /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/;

/** The UTC day an update belongs to, `2026-10-16`, or undefined for a malformed time. */
export function dayKey(updatedAt: string): string | undefined {
  if (!UPDATED_AT.test(updatedAt)) return undefined;
  return new Date(updatedAt).toISOString().slice(0, 10);
}

/** Updates grouped by day, newest day first. */
export function groupByDay(updates: Update[]): [string, Update[]][] {
  const groups = new Map<string, Update[]>();
  for (const u of updates) {
    const day = dayKey(u.updatedAt) ?? 'unknown';
    groups.set(day, [...(groups.get(day) ?? []), u]);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a));
}
