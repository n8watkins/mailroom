import { WorkerEntrypoint } from "cloudflare:workers";
import { APPS } from "./apps";
import { count, dayWindow, monthWindow, DAY_MS } from "./caps";
import { eventsFor, handleEvent, type EmailSendingEvent } from "./events";
import { isSuppressed, sendFor } from "./send";
import type { AppUsage, CallerProps, Env, MailEvent, SendRequest, SendResult, Usage } from "./types";

export type { AppUsage, MailEvent, SendRequest, SendResult, Usage } from "./types";

// Rows older than these are deleted by the daily cron.
const SENDS_KEEP_MS = 400 * DAY_MS;
const EVENTS_KEEP_MS = 180 * DAY_MS;

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

export async function usageReport(env: Env, now = Date.now()): Promise<Usage> {
  const day = dayWindow(now);
  const month = monthWindow(now);
  const since = now - 30 * DAY_MS;
  const { results: eventRows } = await env.DB.prepare(
    `SELECT app, type, COUNT(*) AS n FROM email_events
     WHERE received_at >= ? AND type IN ('bounced', 'complained', 'failed') GROUP BY app, type`,
  )
    .bind(since)
    .all<{ app: string | null; type: string; n: number }>();
  const eventCount = (app: string, type: string) => eventRows.find((r) => r.app === app && r.type === type)?.n ?? 0;

  const apps: AppUsage[] = [];
  for (const [id, cfg] of Object.entries(APPS)) {
    apps.push({
      app: id,
      today: await count(env.DB, `app:${id}:${day.id}`),
      month: await count(env.DB, `app:${id}:${month.id}`),
      caps: cfg.caps,
      bounces30d: eventCount(id, "bounced"),
      complaints30d: eventCount(id, "complained"),
      failed30d: eventCount(id, "failed"),
    });
  }
  const suppressions = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppressions").first<{ n: number }>();
  return {
    generatedAt: new Date(now).toISOString(),
    globalToday: await count(env.DB, `global:${day.id}`),
    globalDayCap: Number(env.GLOBAL_DAY_CAP) || 0,
    priorityReserve: Number(env.PRIORITY_RESERVE) || 0,
    suppressions: suppressions?.n ?? 0,
    apps,
  };
}

export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM counters WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sends WHERE created_at < ?").bind(now - SENDS_KEEP_MS),
    env.DB.prepare("DELETE FROM email_events WHERE received_at < ?").bind(now - EVENTS_KEEP_MS),
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
