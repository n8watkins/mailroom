import { APPS, appForSender, type AppConfig } from "./apps";
import { normalizeAddress, suppress } from "./send";
import type { Env, MailEvent } from "./types";

/** An Email Sending event as the queue delivers it (eventSchemaVersion 1). */
export interface EmailSendingEvent {
  type: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload?: {
    eventId?: string;
    messageId?: string;
    sender?: string;
    recipient?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string; smtpEnhancedStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: string; classification?: string; reason?: string };
    failure?: { reason?: string };
    rejection?: { reason?: string };
    complaint?: { reason?: string; feedbackType?: string };
  };
  metadata?: { eventTimestamp?: string };
}

const PREFIX = "cf.email.sending.message.";
// Events the sending app hears about. Delivered and deferred are only stored.
const APP_EVENTS = new Set(["bounced", "complained", "rejected", "failed"]);

export function shortType(type: string): string {
  return type.startsWith(PREFIX) ? type.slice(PREFIX.length) : type;
}

/** Whether an event means the address should never be mailed again. */
export function suppressionReason(event: EmailSendingEvent): string | null {
  const type = shortType(event.type);
  if (type === "complained") return "complained";
  if (type === "bounced" && event.payload?.bounce?.type === "hard") return "hard_bounce";
  return null;
}

export interface EventDeps {
  env: Env;
  apps?: Record<string, AppConfig>;
  now?: () => number;
}

/**
 * Stores one event, suppresses the address when it hard-bounced or
 * complained, and passes it to the app's hook. Safe to run twice for the same
 * event (queues deliver at least once). Throws when the hook fails, so the
 * queue retries it.
 */
export async function handleEvent(raw: EmailSendingEvent, deps: EventDeps): Promise<MailEvent | null> {
  const apps = deps.apps ?? APPS;
  const now = (deps.now ?? Date.now)();
  const db = deps.env.DB;
  const p = raw?.payload;
  if (!raw || typeof raw.type !== "string" || !raw.type.startsWith(PREFIX) || !p) {
    console.log(JSON.stringify({ event: "event_ignored", type: raw?.type ?? null }));
    return null;
  }
  const type = shortType(raw.type);
  const eventId = p.eventId ?? `${p.messageId ?? "unknown"}:${type}:${p.recipient ?? ""}`;

  let app: string | null = null;
  if (p.messageId) {
    const row = await db.prepare("SELECT app FROM sends WHERE message_id = ?").bind(p.messageId).first<{ app: string }>();
    app = row?.app ?? null;
  }
  if (!app && p.sender) app = appForSender(p.sender, apps) ?? null;

  const reason = suppressionReason(raw);
  const event: MailEvent = {
    eventId,
    app,
    type,
    messageId: p.messageId ?? null,
    sender: p.sender ?? null,
    recipient: p.recipient ? normalizeAddress(p.recipient) : null,
    bounceType: p.bounce?.type ?? null,
    smtpStatus: p.delivery?.smtpEnhancedStatusCode ?? p.delivery?.smtpStatusCode ?? null,
    reason: p.bounce?.reason ?? p.failure?.reason ?? p.rejection?.reason ?? p.complaint?.reason ?? p.delivery?.smtpResponse ?? null,
    occurredAt: raw.metadata?.eventTimestamp ?? null,
    suppressed: reason !== null,
  };

  await db
    .prepare(
      `INSERT INTO email_events (event_id, app, type, message_id, sender, recipient, bounce_type, smtp_status, reason, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`,
    )
    .bind(event.eventId, app, type, event.messageId, event.sender, event.recipient, event.bounceType, event.smtpStatus, event.reason, event.occurredAt, now)
    .run();

  if (reason && event.recipient) {
    await suppress(db, { recipient: event.recipient, reason, app, eventId, now });
  }

  if (!APP_EVENTS.has(type) || !app) return event;

  const done = await db.prepare("SELECT hook_done FROM email_events WHERE event_id = ?").bind(eventId).first<{ hook_done: number }>();
  if (done?.hook_done) return event;

  const hookName = apps[app]?.hook;
  const hook = hookName ? deps.env[hookName as `HOOK_${string}`] : undefined;
  if (hook) {
    await hook.onEmailEvent(event);
    console.log(JSON.stringify({ event: "hook_called", app, type }));
  }
  await db.prepare("UPDATE email_events SET hook_done = 1 WHERE event_id = ?").bind(eventId).run();
  return event;
}

/** An app's own events, oldest first, after a cursor (the `receivedAt` of the last one it read). */
export async function eventsFor(
  db: D1Database,
  app: string,
  opts: { since?: number; limit?: number } = {},
): Promise<Array<MailEvent & { receivedAt: number }>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await db
    .prepare(
      `SELECT e.*, (s.recipient IS NOT NULL) AS is_suppressed FROM email_events e
       LEFT JOIN suppressions s ON s.recipient = e.recipient
       WHERE e.app = ? AND e.received_at > ? ORDER BY e.received_at ASC, e.event_id ASC LIMIT ?`,
    )
    .bind(app, opts.since ?? 0, limit)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    eventId: String(r.event_id),
    app: (r.app as string) ?? null,
    type: String(r.type),
    messageId: (r.message_id as string) ?? null,
    sender: (r.sender as string) ?? null,
    recipient: (r.recipient as string) ?? null,
    bounceType: (r.bounce_type as string) ?? null,
    smtpStatus: (r.smtp_status as string) ?? null,
    reason: (r.reason as string) ?? null,
    occurredAt: (r.occurred_at as string) ?? null,
    suppressed: Boolean(r.is_suppressed),
    receivedAt: Number(r.received_at),
  }));
}
