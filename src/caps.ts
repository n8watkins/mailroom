/**
 * Hard caps with atomic counters in D1. A reservation takes one unit from
 * every counter it names or from none: each counter is incremented only while
 * it is under its limit, and a refused reservation gives back what it took.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface CapRule {
  key: string;
  limit: number;
  expiresAt: number;
  /** The code a refusal by this rule returns. */
  code: string;
}

export function dayWindow(now: number): { id: string; end: number } {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return { id: new Date(start).toISOString().slice(0, 10), end: start + DAY_MS };
}

export function monthWindow(now: number): { id: string; end: number } {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { id: d.toISOString().slice(0, 7), end };
}

/** Takes one unit from each rule, in order. Returns the code of the first rule that refused, or null. */
export async function reserve(db: D1Database, rules: CapRule[]): Promise<string | null> {
  const taken: CapRule[] = [];
  for (const rule of rules) {
    const row = await db
      .prepare(
        `INSERT INTO counters (key, n, expires_at) VALUES (?1, 1, ?3)
         ON CONFLICT (key) DO UPDATE SET n = n + 1 WHERE n < ?2
         RETURNING n`,
      )
      .bind(rule.key, rule.limit, rule.expiresAt)
      .first<{ n: number }>();
    // A fresh row starts at 1 even with a limit of 0, so check the limit here too.
    if (!row || row.n > rule.limit) {
      if (row) taken.push(rule);
      await release(db, taken);
      return rule.code;
    }
    taken.push(rule);
  }
  return null;
}

/** Gives back one unit per rule, for a send that did not go out. */
export async function release(db: D1Database, rules: CapRule[]): Promise<void> {
  if (rules.length === 0) return;
  await db.batch(rules.map((rule) => db.prepare("UPDATE counters SET n = n - 1 WHERE key = ? AND n > 0").bind(rule.key)));
}

export async function count(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare("SELECT n FROM counters WHERE key = ?").bind(key).first<{ n: number }>();
  return row?.n ?? 0;
}
