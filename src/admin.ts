import { APPS } from "./apps";
import type { Env } from "./types";

/**
 * What the owner's dashboard (n8builds-admin) reads and changes, through the
 * MailroomAdmin entrypoint. Only a Worker bound to that entrypoint can call it;
 * apps bind to Mailroom, which has none of these methods.
 *
 * Nothing here returns a full recipient address or any email content:
 * addresses are masked ("jo***@gmail.com"), and SMTP replies have their
 * addresses masked too. Every change is written to audit_log first.
 */

export interface SendRow {
  id: number;
  at: number;
  app: string;
  kind: string;
  recipient: string;
  status: string;
  error: string | null;
}

export interface ProblemRow {
  eventId: string;
  at: number;
  app: string | null;
  type: string;
  recipient: string | null;
  bounceType: string | null;
  smtpStatus: string | null;
  reason: string | null;
}

export interface SuppressionRow {
  /** Opaque id for removeSuppression; never the address. */
  id: number;
  recipient: string;
  reason: string;
  app: string | null;
  createdAt: number;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  app: string | null;
  detail: string;
}

export type ActionResult = { ok: true; detail: string } | { ok: false; error: string };

const MAX_LIMIT = 200;
const clampLimit = (limit: number | undefined, fallback: number) => Math.min(Math.max(Math.trunc(limit ?? fallback) || fallback, 1), MAX_LIMIT);

/** "jo***@gmail.com": the first two characters (one for a short name) and the domain. */
export function maskAddress(address: string | null | undefined): string {
  if (!address) return "";
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  const keep = local.length <= 3 ? 1 : 2;
  return `${local.slice(0, keep)}***${address.slice(at).toLowerCase()}`;
}

/** Masks every address inside a free-text SMTP reply. */
export function maskText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, (match) => maskAddress(match)).slice(0, 300);
}

function cleanActor(actor: unknown): string | null {
  if (typeof actor !== "string") return null;
  const trimmed = actor.trim().slice(0, 100);
  return trimmed ? trimmed : null;
}

async function audit(db: D1Database, entry: { actor: string; action: string; app: string | null; detail: string; now: number }) {
  return db
    .prepare("INSERT INTO audit_log (at, actor, action, app, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(entry.now, entry.actor, entry.action, entry.app, entry.detail);
}

export async function recentSends(db: D1Database, opts: { limit?: number; app?: string } = {}): Promise<SendRow[]> {
  const limit = clampLimit(opts.limit, 50);
  const stmt = opts.app
    ? db.prepare("SELECT id, created_at, app, kind, recipient, status, error FROM sends WHERE app = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(opts.app, limit)
    : db.prepare("SELECT id, created_at, app, kind, recipient, status, error FROM sends ORDER BY created_at DESC, id DESC LIMIT ?").bind(limit);
  const { results } = await stmt.all<{ id: number; created_at: number; app: string; kind: string; recipient: string; status: string; error: string | null }>();
  return results.map((r) => ({ id: r.id, at: r.created_at, app: r.app, kind: r.kind, recipient: maskAddress(r.recipient), status: r.status, error: r.error }));
}

export async function problemEvents(db: D1Database, opts: { limit?: number } = {}): Promise<ProblemRow[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, received_at, app, type, recipient, bounce_type, smtp_status, reason FROM email_events
       WHERE type IN ('bounced', 'complained', 'failed', 'rejected') ORDER BY received_at DESC LIMIT ?`,
    )
    .bind(clampLimit(opts.limit, 50))
    .all<{ event_id: string; received_at: number; app: string | null; type: string; recipient: string | null; bounce_type: string | null; smtp_status: string | null; reason: string | null }>();
  return results.map((r) => ({
    eventId: r.event_id,
    at: r.received_at,
    app: r.app,
    type: r.type,
    recipient: r.recipient ? maskAddress(r.recipient) : null,
    bounceType: r.bounce_type,
    smtpStatus: r.smtp_status,
    reason: maskText(r.reason),
  }));
}

export async function suppressionList(db: D1Database, opts: { limit?: number } = {}): Promise<SuppressionRow[]> {
  const { results } = await db
    .prepare("SELECT rowid AS id, recipient, reason, app, created_at FROM suppressions ORDER BY created_at DESC LIMIT ?")
    .bind(clampLimit(opts.limit, 100))
    .all<{ id: number; recipient: string; reason: string; app: string | null; created_at: number }>();
  return results.map((r) => ({ id: r.id, recipient: maskAddress(r.recipient), reason: r.reason, app: r.app, createdAt: r.created_at }));
}

export async function auditLog(db: D1Database, opts: { limit?: number } = {}): Promise<AuditRow[]> {
  const { results } = await db
    .prepare("SELECT id, at, actor, action, app, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT ?")
    .bind(clampLimit(opts.limit, 50))
    .all<AuditRow>();
  return results;
}

export async function removeSuppression(db: D1Database, id: number, actorIn: unknown, now = Date.now()): Promise<ActionResult> {
  const actor = cleanActor(actorIn);
  if (!actor) return { ok: false, error: "An actor is required." };
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown suppression." };
  const row = await db.prepare("SELECT recipient, reason, app FROM suppressions WHERE rowid = ?").bind(id).first<{ recipient: string; reason: string; app: string | null }>();
  if (!row) return { ok: false, error: "That address is no longer suppressed." };
  const detail = `Removed ${maskAddress(row.recipient)} (${row.reason}) from the suppression list`;
  await db.batch([db.prepare("DELETE FROM suppressions WHERE rowid = ?").bind(id), await audit(db, { actor, action: "suppression.remove", app: row.app, detail, now })]);
  return { ok: true, detail };
}

export async function setPaused(db: D1Database, app: string, paused: boolean, actorIn: unknown, now = Date.now()): Promise<ActionResult> {
  const actor = cleanActor(actorIn);
  if (!actor) return { ok: false, error: "An actor is required." };
  if (!APPS[app]) return { ok: false, error: "Unknown app." };
  if (typeof paused !== "boolean") return { ok: false, error: "`paused` must be true or false." };
  const detail = paused ? `Paused all email from ${app}` : `Resumed email from ${app}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO app_settings (app, paused, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (app) DO UPDATE SET paused = ?2, updated_at = ?3, updated_by = ?4`,
      )
      .bind(app, paused ? 1 : 0, now, actor),
    await audit(db, { actor, action: paused ? "app.pause" : "app.resume", app, detail, now }),
  ]);
  return { ok: true, detail };
}

/** Sets the app's daily cap, or puts back its default from src/apps.ts with `null`. At most the all-app daily cap. */
export async function setDailyCap(db: D1Database, env: Env, app: string, cap: number | null, actorIn: unknown, now = Date.now()): Promise<ActionResult> {
  const actor = cleanActor(actorIn);
  if (!actor) return { ok: false, error: "An actor is required." };
  const config = APPS[app];
  if (!config) return { ok: false, error: "Unknown app." };
  const ceiling = Number(env.GLOBAL_DAY_CAP) || 0;
  if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > ceiling)) {
    return { ok: false, error: `The daily cap must be a whole number from 0 to ${ceiling}.` };
  }
  const before = await db.prepare("SELECT day_cap FROM app_settings WHERE app = ?").bind(app).first<{ day_cap: number | null }>();
  const from = before?.day_cap ?? config.caps.day;
  const to = cap ?? config.caps.day;
  const detail = cap === null ? `Daily cap for ${app} back to its default of ${to} (was ${from})` : `Daily cap for ${app} set to ${to} (was ${from})`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO app_settings (app, day_cap, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (app) DO UPDATE SET day_cap = ?2, updated_at = ?3, updated_by = ?4`,
      )
      .bind(app, cap, now, actor),
    await audit(db, { actor, action: "app.day_cap", app, detail, now }),
  ]);
  return { ok: true, detail };
}
