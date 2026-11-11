import { APPS, matchesSender, type AppConfig } from "./apps";
import { dayWindow, monthWindow, release, reserve, type CapRule } from "./caps";
import type { Env, SendErrorCode, SendRequest, SendResult } from "./types";

const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
// A pending send older than this is taken to have died before recording its
// result, so a retry with the same key may send it again.
const PENDING_STALE_MS = 15 * 60 * 1000;
// RFC 7230 token characters: what a header name may hold.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// Control characters (CR and LF among them) never belong in a header value or a display name.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SendDeps {
  env: Env;
  apps?: Record<string, AppConfig>;
  now?: () => number;
}

function fail(code: SendErrorCode, message: string, retryable = false): SendResult {
  return { ok: false, code, retryable, message };
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Checks a request against the app's config. Returns an error result, or the sender to use. */
export function validate(app: AppConfig, req: SendRequest): SendResult | { from: string } {
  if (!req || typeof req !== "object") return fail("invalid", "The request must be an object.");
  if (typeof req.kind !== "string" || !app.kinds.includes(req.kind)) {
    return fail("kind_not_allowed", `Kind "${String(req.kind)}" is not one of this app's kinds.`);
  }
  if (typeof req.to !== "string" || !EMAIL_RE.test(req.to.trim())) return fail("invalid", "`to` must be one email address.");
  if (typeof req.subject !== "string" || req.subject.trim() === "") return fail("invalid", "`subject` is required.");
  if (/[\r\n]/.test(req.subject)) return fail("invalid", "`subject` must be one line.");
  if (typeof req.text !== "string" || req.text.trim() === "") return fail("invalid", "`text` is required.");
  if (req.html !== undefined && typeof req.html !== "string") return fail("invalid", "`html` must be a string.");
  if (req.replyTo !== undefined && (typeof req.replyTo !== "string" || !EMAIL_RE.test(req.replyTo.trim()))) {
    return fail("invalid", "`replyTo` must be one email address.");
  }
  if (req.fromName !== undefined && (typeof req.fromName !== "string" || CONTROL_RE.test(req.fromName) || req.fromName.length > 100)) {
    return fail("invalid", "`fromName` must be one line of at most 100 characters.");
  }
  if (req.headers !== undefined) {
    if (!req.headers || typeof req.headers !== "object" || Array.isArray(req.headers)) return fail("invalid", "`headers` must be an object.");
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HEADER_NAME_RE.test(name)) return fail("invalid", `Header name "${name.slice(0, 100)}" is not valid.`);
      if (typeof value !== "string" || CONTROL_RE.test(value)) return fail("invalid", `Header "${name}" must be a one-line string.`);
    }
  }
  if (req.attachments !== undefined && !Array.isArray(req.attachments)) return fail("invalid", "`attachments` must be an array.");
  if (req.key !== undefined && (typeof req.key !== "string" || req.key.length === 0 || req.key.length > 200)) {
    return fail("invalid", "`key` must be a string of 1 to 200 characters.");
  }
  if (req.from !== undefined && typeof req.from !== "string") return fail("invalid", "`from` must be one email address.");
  const from = normalizeAddress(req.from ?? defaultSender(app) ?? "");
  // EMAIL_RE first: a domain rule ("@example.com") checks only the domain, so
  // the local part must be shown to be a plain address here.
  if (!from || !EMAIL_RE.test(from) || !app.senders.some((allowed) => matchesSender(allowed, from))) {
    return fail("sender_not_allowed", `This app may not send as "${from || "(none)"}".`);
  }
  return { from };
}

function defaultSender(app: AppConfig): string | undefined {
  return app.senders.find((s) => !s.startsWith("@"));
}

/** The binding's error codes (Workers binding errors carry `.code`). */
export function classifyBindingError(error: unknown): { code: SendErrorCode; retryable: boolean } {
  const code = (error as { code?: unknown })?.code;
  switch (code) {
    case "E_RECIPIENT_SUPPRESSED":
      return { code: "suppressed", retryable: false };
    case "E_RATE_LIMIT_EXCEEDED":
      return { code: "rate_limited", retryable: true };
    case "E_DAILY_LIMIT_EXCEEDED":
      return { code: "daily_limit", retryable: true };
    case "E_INTERNAL_SERVER_ERROR":
    case "E_DELIVERY_FAILED":
      return { code: "unavailable", retryable: true };
    case undefined:
    case null:
      // No code: a network or runtime failure, not a verdict on the message.
      return { code: "unavailable", retryable: true };
    default:
      return { code: "rejected", retryable: false };
  }
}

export async function isSuppressed(db: D1Database, recipient: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM suppressions WHERE recipient = ?").bind(normalizeAddress(recipient)).first();
  return row !== null;
}

export async function suppress(
  db: D1Database,
  entry: { recipient: string; reason: string; app: string | null; eventId: string | null; now: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO suppressions (recipient, reason, app, event_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (recipient) DO NOTHING")
    .bind(normalizeAddress(entry.recipient), entry.reason, entry.app, entry.eventId, entry.now)
    .run();
}

/** The owner's overrides for an app (MailroomAdmin), or the defaults. */
export async function appSettings(db: D1Database, appId: string): Promise<{ paused: boolean; dayCap: number | null }> {
  const row = await db.prepare("SELECT paused, day_cap FROM app_settings WHERE app = ?").bind(appId).first<{ paused: number; day_cap: number | null }>();
  return { paused: row?.paused === 1, dayCap: row?.day_cap ?? null };
}

export function capRules(appId: string, app: AppConfig, kind: string, recipient: string, env: Env, now: number, dayCap?: number | null): CapRule[] {
  const day = dayWindow(now);
  const month = monthWindow(now);
  const globalCap = Number(env.GLOBAL_DAY_CAP) || 0;
  const reserveForPriority = Math.min(Number(env.PRIORITY_RESERVE) || 0, globalCap);
  const priority = app.priority?.includes(kind) ?? false;
  return [
    { key: `recipient:${day.id}:${recipient}`, limit: app.caps.recipientDay, expiresAt: day.end, code: "cap_recipient" },
    { key: `app:${appId}:${day.id}`, limit: dayCap ?? app.caps.day, expiresAt: day.end, code: "cap_app_day" },
    { key: `app:${appId}:${month.id}`, limit: app.caps.month, expiresAt: month.end, code: "cap_app_month" },
    {
      key: `global:${day.id}`,
      limit: priority ? globalCap : globalCap - reserveForPriority,
      expiresAt: day.end,
      code: "cap_global_day",
    },
  ];
}

/** Sends one email for an app. Never throws: a refused or failed send, or a database error, comes back as a result. */
export async function sendFor(appId: string | undefined, req: SendRequest, deps: SendDeps): Promise<SendResult> {
  try {
    return await sendOnce(appId, req, deps);
  } catch (error) {
    // A database error before the email went out (sendOnce does not throw after it).
    console.log(JSON.stringify({ event: "send_error", app: appId ?? null, error: String(error) }));
    return fail("unavailable", "mailroom could not record this send; try again later.", true);
  }
}

async function sendOnce(appId: string | undefined, req: SendRequest, deps: SendDeps): Promise<SendResult> {
  const apps = deps.apps ?? APPS;
  const now = (deps.now ?? Date.now)();
  const { env } = deps;
  const db = env.DB;

  const app = appId ? apps[appId] : undefined;
  if (!appId || !app) return fail("unknown_app", "This binding has no known `props.app`.");

  const checked = validate(app, req);
  if ("ok" in checked) return checked;
  const from = checked.from;
  const recipient = normalizeAddress(req.to);

  const settings = await appSettings(db, appId);
  if (settings.paused) return fail("paused", "The owner paused this app's email; it resumes from the admin.", true);

  if (await isSuppressed(db, recipient)) {
    return fail("suppressed", "This address bounced or complained before; mailroom will not send to it.");
  }

  // Idempotency: claim the key before sending.
  let rowId: number | null = null;
  if (req.key) {
    const existing = await db
      .prepare("SELECT id, status, message_id, updated_at FROM sends WHERE app = ? AND idem_key = ?")
      .bind(appId, req.key)
      .first<{ id: number; status: string; message_id: string | null; updated_at: number }>();
    if (existing?.status === "sent") return { ok: true, messageId: existing.message_id ?? "", duplicate: true };
    if (existing?.status === "pending" && now - existing.updated_at < PENDING_STALE_MS) {
      return fail("in_progress", "A send with this key is in progress.", true);
    }
    if (existing) {
      const claimed = await db
        .prepare("UPDATE sends SET status = 'pending', error = NULL, updated_at = ? WHERE id = ? AND updated_at = ?")
        .bind(now, existing.id, existing.updated_at)
        .run();
      if (claimed.meta.changes !== 1) return fail("in_progress", "A send with this key is in progress.", true);
      rowId = existing.id;
    }
  }
  if (rowId === null) {
    const inserted = await db
      .prepare(
        `INSERT INTO sends (app, kind, sender, recipient, idem_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT DO NOTHING RETURNING id`,
      )
      .bind(appId, req.kind, from, recipient, req.key ?? null, now, now)
      .first<{ id: number }>();
    if (!inserted) return fail("in_progress", "A send with this key is in progress.", true);
    rowId = inserted.id;
  }

  const rules = capRules(appId, app, req.kind, recipient, env, now, settings.dayCap);
  const refused = await reserve(db, rules);
  if (refused) {
    await markFailed(db, rowId, refused, now);
    return fail(refused as SendErrorCode, capMessage(refused), true);
  }

  let messageId: string;
  try {
    const result = await env.EMAIL.send({
      to: req.to.trim(),
      from: req.fromName ? { email: from, name: req.fromName } : from,
      subject: req.subject,
      text: req.text,
      ...(req.html ? { html: req.html } : {}),
      ...(req.replyTo ? { replyTo: req.replyTo.trim() } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.attachments ? { attachments: req.attachments } : {}),
    });
    messageId = result.messageId;
  } catch (error) {
    const { code, retryable } = classifyBindingError(error);
    await release(db, rules);
    await markFailed(db, rowId, code, now);
    if (code === "suppressed") {
      await suppress(db, { recipient, reason: "cloudflare_suppressed", app: appId, eventId: null, now });
    }
    console.log(JSON.stringify({ event: "send_failed", app: appId, kind: req.kind, code, binding: (error as { code?: string })?.code }));
    return fail(code, error instanceof Error ? error.message : String(error), retryable);
  }

  // The email is out: bookkeeping must not turn this into a failure, or the
  // app would retry and send it twice.
  try {
    await db.prepare("UPDATE sends SET status = 'sent', message_id = ?, updated_at = ? WHERE id = ?").bind(messageId, now, rowId).run();
  } catch (error) {
    console.log(JSON.stringify({ event: "send_record_failed", app: appId, kind: req.kind, error: String(error) }));
  }
  console.log(JSON.stringify({ event: "sent", app: appId, kind: req.kind }));
  return { ok: true, messageId };
}

async function markFailed(db: D1Database, id: number, error: string, now: number): Promise<void> {
  await db.prepare("UPDATE sends SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error, now, id).run();
}

function capMessage(code: string): string {
  switch (code) {
    case "cap_recipient":
      return "This recipient reached today's limit for this app.";
    case "cap_app_day":
      return "This app reached its daily email cap.";
    case "cap_app_month":
      return "This app reached its monthly email cap.";
    default:
      return "Today's email allowance across all apps is used up for this kind.";
  }
}
