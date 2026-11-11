import { WorkerEntrypoint } from "cloudflare:workers";
import {
  auditLog,
  problemEvents,
  recentSends,
  removeSuppression,
  setDailyCap,
  setPaused,
  suppressionList,
  type ActionResult,
  type AuditRow,
  type ProblemRow,
  type SendRow,
  type SuppressionRow,
} from "./admin";
import { APPS } from "./apps";
import { dayAlertAt, monthAlerts } from "./alerts";
import { count, dayWindow, globalMonthWindow, monthCaps, monthWindow, MONTH_WINDOW_DAYS, sumRange, DAY_MS } from "./caps";
import { eventsFor, handleEvent, type EmailSendingEvent } from "./events";
import { isSuppressed, sendFor } from "./send";
import type { AppUsage, CallerProps, Env, MailEvent, SendRequest, SendResult, Usage } from "./types";

export type { AppUsage, MailEvent, SendRequest, SendResult, Usage } from "./types";
export type { ActionResult, AuditRow, ProblemRow, SendRow, SuppressionRow } from "./admin";

// Retention, as the privacy policies that name mailroom state it (open-ping
// docs/legal/PRIVACY.md): the recipient, kind and time of each send for 400
// days; what became of it (events, and a send's message id and error) for 180.
const SENDS_KEEP_MS = 400 * DAY_MS;
const STATUS_KEEP_MS = 180 * DAY_MS;

/**
 * The RPC interface apps call through a service binding:
 *
 *   { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom", "props": { "app": "<id>" } }
 *
 * `props.app` names the caller; it is set in the caller's deploy config, so
 * one app can't send as another by accident.
 */
export class Mailroom extends WorkerEntrypoint<Env, CallerProps> {
  private get app(): string | undefined {
    return this.ctx.props?.app;
  }

  /** Sends one email. Never throws for a refused send: check `ok`, and retry later only when `retryable`. */
  async send(request: SendRequest): Promise<SendResult> {
    return sendFor(this.app, request, { env: this.env });
  }

  /** Whether mailroom refuses to send to this address (it hard-bounced or complained). */
  async isSuppressed(address: string): Promise<boolean> {
    return isSuppressed(this.env.DB, address);
  }

  /** This app's events (bounces, complaints, deliveries) after a `receivedAt` cursor, oldest first. */
  async events(opts: { since?: number; limit?: number } = {}): Promise<Array<MailEvent & { receivedAt: number }>> {
    const app = this.app;
    if (!app || !APPS[app]) return [];
    return eventsFor(this.env.DB, app, opts);
  }

  /** Sends and caps per app, for the usage view. Holds no addresses. */
  async usage(): Promise<Usage> {
    return usageReport(this.env);
  }
}

/**
 * The owner's dashboard (n8builds-admin) only:
 *
 *   { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "MailroomAdmin" }
 *
 * Reads return masked addresses and no email content. Each change takes the
 * signed-in owner as `actor` and is written to the audit log.
 */
export class MailroomAdmin extends WorkerEntrypoint<Env> {
  async usage(): Promise<Usage> {
    return usageReport(this.env);
  }

  async recentSends(opts: { limit?: number; app?: string } = {}): Promise<SendRow[]> {
    return recentSends(this.env.DB, opts);
  }

  async problems(opts: { limit?: number } = {}): Promise<ProblemRow[]> {
    return problemEvents(this.env.DB, opts);
  }

  async suppressions(opts: { limit?: number } = {}): Promise<SuppressionRow[]> {
    return suppressionList(this.env.DB, opts);
  }

  async auditLog(opts: { limit?: number } = {}): Promise<AuditRow[]> {
    return auditLog(this.env.DB, opts);
  }

  async removeSuppression(id: number, actor: string): Promise<ActionResult> {
    return removeSuppression(this.env.DB, id, actor);
  }

  async setPaused(app: string, paused: boolean, actor: string): Promise<ActionResult> {
    return setPaused(this.env.DB, app, paused, actor);
  }

  async setDailyCap(app: string, cap: number | null, actor: string): Promise<ActionResult> {
    return setDailyCap(this.env.DB, this.env, app, cap, actor);
  }
}

export async function usageReport(env: Env, now = Date.now()): Promise<Usage> {
  const day = dayWindow(now);
  const month = monthWindow(now);
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const db = env.DB;
  const [problems, sent, first, suppressions] = await db.batch([
    db
      .prepare(
        `SELECT app, type, COUNT(*) AS n FROM email_events
         WHERE received_at >= ? AND type IN ('bounced', 'complained', 'failed') GROUP BY app, type`,
      )
      .bind(now - 30 * DAY_MS),
    // A message counts once, when it reached delivered or bounced: what the
    // account's monthly allowance counts (sends blocked by suppression don't).
    db
      .prepare(
        `SELECT app, sender, COUNT(DISTINCT COALESCE(message_id, event_id)) AS n FROM email_events
         WHERE received_at >= ? AND type IN ('delivered', 'bounced') GROUP BY app, sender`,
      )
      .bind(monthStart),
    db.prepare("SELECT MIN(received_at) AS since FROM email_events"),
    db.prepare("SELECT COUNT(*) AS n FROM suppressions"),
  ]);
  const problemRows = (problems?.results ?? []) as Array<{ app: string | null; type: string; n: number }>;
  const sentRows = (sent?.results ?? []) as Array<{ app: string | null; sender: string | null; n: number }>;
  const problemCount = (app: string, type: string) => problemRows.find((r) => r.app === app && r.type === type)?.n ?? 0;
  const sentFor = (app: string) => sentRows.filter((r) => r.app === app).reduce((sum, r) => sum + r.n, 0);

  const { results: settingRows } = await db.prepare("SELECT app, paused, day_cap FROM app_settings").all<{ app: string; paused: number; day_cap: number | null }>();
  const apps: AppUsage[] = [];
  for (const [id, cfg] of Object.entries(APPS)) {
    const setting = settingRows.find((s) => s.app === id);
    apps.push({
      app: id,
      today: await count(db, `app:${id}:${day.id}`),
      month: await count(db, `app:${id}:${month.id}`),
      sentMonth: sentFor(id),
      caps: { ...cfg.caps, day: setting?.day_cap ?? cfg.caps.day },
      defaultDayCap: cfg.caps.day,
      paused: setting?.paused === 1,
      bounces30d: problemCount(id, "bounced"),
      complaints30d: problemCount(id, "complained"),
      failed30d: problemCount(id, "failed"),
    });
  }
  const otherSenders = sentRows
    .filter((r) => r.app === null || !APPS[r.app])
    .map((r) => ({ sender: r.sender ?? "(unknown)", sentMonth: r.n }))
    .sort((a, b) => b.sentMonth - a.sentMonth);
  const globalMonth = globalMonthWindow(now);
  const monthly = monthCaps(env);
  const monthUsed = await sumRange(db, globalMonth.from, globalMonth.key);
  const attention = monthUsed >= monthly.warnAt;
  const alerts = await monthAlerts(db, now);
  const since = (first?.results?.[0] as { since: number | null } | undefined)?.since ?? null;
  return {
    generatedAt: new Date(now).toISOString(),
    monthStart: new Date(monthStart).toISOString().slice(0, 10),
    eventsSince: since,
    globalToday: await count(db, `global:${day.id}`),
    globalDayCap: Number(env.GLOBAL_DAY_CAP) || 0,
    priorityReserve: Number(env.PRIORITY_RESERVE) || 0,
    globalMonth: {
      used: monthUsed,
      cap: monthly.cap,
      priorityReserve: monthly.priorityReserve,
      windowStart: globalMonth.start,
      windowDays: MONTH_WINDOW_DAYS,
      warnAt: monthly.warnAt,
      attention,
      attentionSince: attention ? (alerts[0]?.at ?? null) : null,
      alerts,
    },
    globalDayCappedAt: await dayAlertAt(db, now),
    monthlyIncluded: Number(env.MONTHLY_INCLUDED) || 3000,
    accountMonth: sentRows.reduce((sum, r) => sum + r.n, 0),
    otherSenders,
    suppressions: (suppressions?.results?.[0] as { n: number } | undefined)?.n ?? 0,
    apps,
  };
}

export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM counters WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sends WHERE created_at < ?").bind(now - SENDS_KEEP_MS),
    env.DB.prepare("UPDATE sends SET message_id = NULL, error = NULL WHERE created_at < ? AND (message_id IS NOT NULL OR error IS NOT NULL)").bind(
      now - STATUS_KEEP_MS,
    ),
    env.DB.prepare("DELETE FROM email_events WHERE received_at < ?").bind(now - STATUS_KEEP_MS),
  ]);
}

export default {
  // No public HTTP interface: apps reach mailroom only through service bindings.
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },

  // Email Sending events from the "mailroom-email-events" queue.
  async queue(batch: MessageBatch<EmailSendingEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleEvent(message.body, { env });
        message.ack();
      } catch (error) {
        console.log(JSON.stringify({ event: "event_failed", type: message.body?.type ?? null, attempts: message.attempts, error: String(error) }));
        message.retry({ delaySeconds: Math.min(60 * 2 ** message.attempts, 3600) });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env, EmailSendingEvent>;
