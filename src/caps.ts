/**
 * Hard caps with atomic counters in D1. A reservation takes one unit from
 * every counter it names or from none: each counter is incremented only while
 * it is under its limit, and a refused reservation gives back what it took.
 */
import type { Env } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface CapRule {
  key: string;
  limit: number;
  expiresAt: number;
  /** The code a refusal by this rule returns. */
  code: string;
  /**
   * A rolling window: the limit holds for the sum of every counter from
   * `sumFrom` through `key` (keys sort by date), and `key` is today's.
   */
  sumFrom?: string;
}

/**
 * The all-app monthly cap counts a rolling window of this many UTC days,
 * today included. Cloudflare's included emails reset with the account's
 * billing cycle, which need not start on the 1st or at UTC midnight. A
 * billing cycle is at most 31 days, so it touches at most 32 UTC days, and
 * every one of them falls inside one 32-day window: no billing cycle can hold
 * more than the cap, whatever day it starts on. A calendar month cannot
 * promise that, since a cycle that starts mid-month would see the end of one
 * calendar month's allowance and the start of the next.
 */
export const MONTH_WINDOW_DAYS = 32;

/** Today's key in the all-app monthly window, the first key it sums from, and when today's counter may go. */
export function globalMonthWindow(now: number): { key: string; from: string; start: string; expiresAt: number } {
  const today = dayWindow(now);
  const start = dayWindow(now - (MONTH_WINDOW_DAYS - 1) * DAY_MS).id;
  return {
    key: `globalm:${today.id}`,
    from: `globalm:${start}`,
    start,
    expiresAt: today.end + (MONTH_WINDOW_DAYS - 1) * DAY_MS,
  };
}

/** The sum of the counters from `from` through `to` (keys of one kind, sorted by date). */
export async function sumRange(db: D1Database, from: string, to: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM counters WHERE key BETWEEN ? AND ?").bind(from, to).first<{ n: number }>();
  return row?.n ?? 0;
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
    const row = await (rule.sumFrom === undefined
      ? db
          .prepare(
            `INSERT INTO counters (key, n, expires_at) VALUES (?1, 1, ?3)
             ON CONFLICT (key) DO UPDATE SET n = n + 1 WHERE n < ?2
             RETURNING n`,
          )
          .bind(rule.key, rule.limit, rule.expiresAt)
      : // One statement, so the check and the increment are atomic (D1 runs
        // one write at a time): no row comes back when the window is full.
        db
          .prepare(
            `INSERT INTO counters (key, n, expires_at)
             SELECT ?1, 1, ?3 WHERE (SELECT COALESCE(SUM(n), 0) FROM counters WHERE key BETWEEN ?4 AND ?1) < ?2
             ON CONFLICT (key) DO UPDATE SET n = n + 1
             RETURNING n`,
          )
          .bind(rule.key, rule.limit, rule.expiresAt, rule.sumFrom)
    ).first<{ n: number }>();
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

/** What GLOBAL_MONTH_CAP and PRIORITY_MONTH_RESERVE fall back to when unset: never unlimited. */
export const DEFAULT_GLOBAL_MONTH_CAP = 2500;
export const DEFAULT_PRIORITY_MONTH_RESERVE = 300;
/** The share of the monthly cap where the admin shows "Needs attention": the first alert threshold (src/alerts.ts). */
export const MONTH_WARN_RATIO = 0.7;

function wholeOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** The all-app monthly cap, its sign-in reserve and the warning line, from the env. */
export function monthCaps(env: Env): { cap: number; priorityReserve: number; warnAt: number } {
  const cap = wholeOr(env.GLOBAL_MONTH_CAP, DEFAULT_GLOBAL_MONTH_CAP);
  const priorityReserve = Math.min(wholeOr(env.PRIORITY_MONTH_RESERVE, DEFAULT_PRIORITY_MONTH_RESERVE), cap);
  return { cap, priorityReserve, warnAt: Math.ceil(cap * MONTH_WARN_RATIO) };
}
