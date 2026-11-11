import { count, dayWindow, globalMonthWindow, monthCaps, MONTH_WINDOW_DAYS, reserve, sumRange, DAY_MS, type CapRule } from "./caps";
import type { Env } from "./types";

/**
 * Emails to the owner as the all-app caps fill up: at 70, 85, 95 and 100% of
 * GLOBAL_MONTH_CAP, and when GLOBAL_DAY_CAP is reached. Nobody else is ever
 * emailed, and the global caps never block these: the owner's address is a
 * verified Email Routing destination, which Cloudflare neither bills nor
 * counts toward the account's quota or daily limit. Their own small limits
 * (ALERT_DAY_LIMIT, ALERT_WINDOW_LIMIT) keep a bug from turning into a loop.
 *
 * Each threshold is claimed with a counters row before its email goes out, so
 * it fires once per period: once per 32-day window for the monthly cap (the
 * window the cap counts), once per UTC day for the daily cap. The rows are
 * also what the admin shows as "Needs attention".
 */

/** Percentages of GLOBAL_MONTH_CAP that send an alert. The first one is the admin's "Needs attention" line. */
export const MONTH_ALERT_THRESHOLDS = [70, 85, 95, 100] as const;
/** Alert emails a UTC day, and in any 32 UTC days: a bound on any bug, well inside the monthly buffer. */
export const ALERT_DAY_LIMIT = 10;
export const ALERT_WINDOW_LIMIT = 40;
/** What mailroom records its own alert sends as, in `sends`. */
export const ALERT_APP = "mailroom";
export const ALERT_KIND = "alert";

const MONTH_MARKER = "alert:month:";
const dayMarker = (dayId: string) => `alert:day:${dayId}:100`;

export type GlobalCapCode = "cap_global_month" | "cap_global_day";

/** The monthly thresholds recorded in the current window, with when each was reached. */
export async function monthAlerts(db: D1Database, now: number): Promise<Array<{ threshold: number; at: number }>> {
  const { results } = await db
    .prepare("SELECT key, n FROM counters WHERE key LIKE 'alert:month:%' AND expires_at >= ?")
    .bind(now)
    .all<{ key: string; n: number }>();
  return results.map((r) => ({ threshold: Number(r.key.slice(MONTH_MARKER.length)), at: r.n })).sort((a, b) => a.threshold - b.threshold);
}

/** When today's daily cap alert was recorded (epoch ms), or null. */
export async function dayAlertAt(db: D1Database, now: number): Promise<number | null> {
  const row = await db.prepare("SELECT n FROM counters WHERE key = ? AND expires_at >= ?").bind(dayMarker(dayWindow(now).id), now).first<{ n: number }>();
  return row?.n ?? null;
}

/**
 * Checks the all-app caps after a send went out or a global cap refused one,
 * and emails the owner about a threshold reached for the first time this
 * period. Never throws.
 */
export async function checkCapAlerts(env: Env, now: number, refused: GlobalCapCode | null = null): Promise<void> {
  try {
    await checkMonth(env, now, refused === "cap_global_month");
    await checkDay(env, now, refused === "cap_global_day");
  } catch (error) {
    console.log(JSON.stringify({ event: "cap_alert_failed", error: String(error) }));
  }
}

async function checkMonth(env: Env, now: number, refused: boolean): Promise<void> {
  const db = env.DB;
  const { cap, priorityReserve } = monthCaps(env);
  const window = globalMonthWindow(now);
  const used = await sumRange(db, window.from, window.key);
  // A refusal means the cap is reached for that kind of email, even while the
  // sign-in reserve is left: every threshold is then reached, so none can
  // arrive after the "reached" alert.
  const reached = MONTH_ALERT_THRESHOLDS.filter((t) => refused || used * 100 >= t * cap);
  if (reached.length === 0) return;
  const recorded = new Set((await monthAlerts(db, now)).map((a) => a.threshold));
  const fresh = reached.filter((t) => !recorded.has(t));
  if (fresh.length === 0) return;
  const claimed = await claim(
    db,
    fresh.map((t) => `${MONTH_MARKER}${t}`),
    now,
    now + MONTH_WINDOW_DAYS * DAY_MS,
  );
  if (claimed.length === 0) return;
  const threshold = Math.max(...claimed.map((key) => Number(key.slice(MONTH_MARKER.length))));
  const capped = threshold === 100;
  const lines = [
    capped
      ? `The all-app monthly email cap is reached: ${n(used)} of ${n(cap)} sends in the last ${MONTH_WINDOW_DAYS} days (since ${window.start}).`
      : `The all-app monthly email cap is at ${threshold}%: ${n(used)} of ${n(cap)} sends in the last ${MONTH_WINDOW_DAYS} days (since ${window.start}).`,
    capped
      ? used < cap
        ? `Every kind but sign-in links is now refused with cap_global_month; the last ${n(priorityReserve)} are kept for sign-in links.`
        : "Every send is now refused with cap_global_month, sign-in links too."
      : `At ${n(cap - priorityReserve)} every kind but sign-in links stops; the last ${n(priorityReserve)} are kept for sign-in links.`,
    capped ? "Sends free up as older days leave the window." : "",
  ];
  const subject = capped ? `mailroom: monthly email cap reached (${n(used)} of ${n(cap)})` : `mailroom: monthly email cap at ${threshold}% (${n(used)} of ${n(cap)})`;
  const sent = await sendAlert(env, now, subject, lines, Date.UTC(...ymd(window.start)), `the last ${MONTH_WINDOW_DAYS} days`);
  if (sent === "failed") await unclaim(db, claimed);
}

async function checkDay(env: Env, now: number, refused: boolean): Promise<void> {
  const db = env.DB;
  const cap = Number(env.GLOBAL_DAY_CAP) || 0;
  const reserveForPriority = Math.min(Number(env.PRIORITY_RESERVE) || 0, cap);
  const day = dayWindow(now);
  const used = await count(db, `global:${day.id}`);
  if (!refused && used < cap) return;
  const claimed = await claim(db, [dayMarker(day.id)], now, day.end);
  if (claimed.length === 0) return;
  const lines = [
    `The all-app daily email cap is reached: ${n(used)} of ${n(cap)} sends today (${day.id}, UTC).`,
    used < cap
      ? `Every kind but sign-in links is now refused with cap_global_day; the last ${n(reserveForPriority)} are kept for sign-in links.`
      : "Every send is now refused with cap_global_day, sign-in links too.",
    "It resets at midnight UTC.",
  ];
  const sent = await sendAlert(env, now, `mailroom: daily email cap reached (${n(used)} of ${n(cap)})`, lines, day.end - DAY_MS, "today");
  if (sent === "failed") await unclaim(db, claimed);
}

/** Claims each marker that is free (absent or expired). Returns the ones this call claimed. */
async function claim(db: D1Database, keys: string[], now: number, expiresAt: number): Promise<string[]> {
  const results = await db.batch(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO counters (key, n, expires_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET n = ?2, expires_at = ?3 WHERE counters.expires_at < ?2`,
        )
        .bind(key, now, expiresAt),
    ),
  );
  return keys.filter((_, i) => results[i]?.meta.changes === 1);
}

async function unclaim(db: D1Database, keys: string[]): Promise<void> {
  await db.batch(keys.map((key) => db.prepare("DELETE FROM counters WHERE key = ?").bind(key)));
}

/**
 * Sends one alert to ALERT_TO, outside the global caps. "skipped" when no
 * alert address is set or the alert limits are used up (the threshold stays
 * recorded, so nothing retries), "failed" when the binding refused it (the
 * caller gives the threshold back for the next send to try again).
 */
export async function sendAlert(env: Env, now: number, subject: string, lines: string[], since: number, period: string): Promise<"sent" | "skipped" | "failed"> {
  const to = env.ALERT_TO?.trim();
  const from = env.ALERT_FROM?.trim();
  if (!to || !from) {
    console.log(JSON.stringify({ event: "cap_alert_skipped", reason: "no ALERT_TO or ALERT_FROM", subject }));
    return "skipped";
  }
  const db = env.DB;
  const day = dayWindow(now);
  const window = globalMonthWindow(now);
  const limits: CapRule[] = [
    { key: `alertsend:${day.id}`, limit: ALERT_DAY_LIMIT, expiresAt: day.end, code: "alert_day_limit" },
    { key: `alertsendm:${day.id}`, limit: ALERT_WINDOW_LIMIT, expiresAt: window.expiresAt, code: "alert_window_limit", sumFrom: `alertsendm:${window.start}` },
  ];
  const refused = await reserve(db, limits);
  if (refused) {
    console.log(JSON.stringify({ event: "cap_alert_skipped", reason: refused, subject }));
    return "skipped";
  }
  const { results: top } = await db
    .prepare("SELECT app, COUNT(*) AS n FROM sends WHERE status = 'sent' AND created_at >= ? AND app != ? GROUP BY app ORDER BY n DESC, app LIMIT 5")
    .bind(since, ALERT_APP)
    .all<{ app: string; n: number }>();
  const text = [
    ...lines.filter(Boolean),
    "",
    `Top apps, ${period}:`,
    ...(top.length ? top.map((r) => `  ${r.app}: ${n(r.n)}`) : ["  (none)"]),
    "",
    env.ADMIN_URL ? `Mailroom admin: ${env.ADMIN_URL}` : "",
    "",
    "Each alert goes out once: monthly thresholds once per 32-day window, the daily cap once per UTC day.",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  try {
    const result = await env.EMAIL.send({ to, from: { email: from, name: "mailroom" }, subject, text });
    await db
      .prepare("INSERT INTO sends (app, kind, sender, recipient, status, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)")
      .bind(ALERT_APP, ALERT_KIND, from.toLowerCase(), to.toLowerCase(), result.messageId, now, now)
      .run();
    console.log(JSON.stringify({ event: "cap_alert_sent", subject }));
    return "sent";
  } catch (error) {
    console.log(JSON.stringify({ event: "cap_alert_failed", subject, binding: (error as { code?: string })?.code, error: String(error) }));
    return "failed";
  }
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m! - 1, d!];
}
