/** What an app passes to `send()`. Templates and rendering stay in the app. */
export interface SendRequest {
  /** What it is: one of the app's kinds in its deployment's apps file. */
  kind: string;
  /** One recipient. */
  to: string;
  subject: string;
  /** Plain text body, always required: some clients show only text, and it helps spam scores. */
  text: string;
  html?: string;
  /** One of the app's senders; its first sender when absent. */
  from?: string;
  /** Display name for the sender. */
  fromName?: string;
  replyTo?: string;
  /** Allowlisted headers only, such as List-Unsubscribe, List-Unsubscribe-Post, In-Reply-To or X-*. */
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
  /** The app's own idempotency key (a job id): a key that already went out is not sent again. */
  key?: string;
}

export type SendErrorCode =
  | "unknown_app"
  | "invalid"
  | "sender_not_allowed"
  | "kind_not_allowed"
  | "suppressed"
  | "paused"
  | "in_progress"
  | "cap_recipient"
  | "cap_app_day"
  | "cap_app_month"
  | "cap_global_day"
  | "rate_limited"
  | "daily_limit"
  | "rejected"
  | "unavailable";

export type SendResult =
  | { ok: true; messageId: string; duplicate?: boolean }
  | { ok: false; code: SendErrorCode; retryable: boolean; message: string };

/** An Email Sending event as mailroom stores it and passes it to the app. */
export interface MailEvent {
  eventId: string;
  app: string | null;
  /** delivered, deferred, bounced, failed, rejected or complained. */
  type: string;
  messageId: string | null;
  sender: string | null;
  recipient: string | null;
  /** hard or soft, for bounces. */
  bounceType: string | null;
  smtpStatus: string | null;
  reason: string | null;
  occurredAt: string | null;
  /** True when mailroom now refuses to send to this recipient. */
  suppressed: boolean;
}

/** One app's numbers for the usage view. */
export interface AppUsage {
  app: string;
  /** Sent through mailroom today and this month (UTC), the numbers its caps count. */
  today: number;
  month: number;
  /**
   * Messages from the app's senders that Email Sending delivered or bounced
   * this month, from the event subscription: counts apps that still send with
   * their own binding too. What the account's monthly allowance counts.
   */
  sentMonth: number;
  /** The caps in force: `day` is the owner's override when one is set. */
  caps: { day: number; month: number; recipientDay: number };
  /** The daily cap from the apps file, without the override. */
  defaultDayCap: number;
  /** True while the owner has paused this app's email. */
  paused: boolean;
  bounces30d: number;
  complaints30d: number;
  failed30d: number;
}

export interface Usage {
  generatedAt: string;
  /** The first day of the month the monthly numbers count from (UTC, YYYY-MM-DD). */
  monthStart: string;
  /** When the first event arrived (epoch ms), or null: monthly numbers start there. */
  eventsSince: number | null;
  globalToday: number;
  globalDayCap: number;
  priorityReserve: number;
  /** Emails a month the account's plan includes before overage (3,000 on Workers Paid). */
  monthlyIncluded: number;
  /** Every delivered or bounced message this month on subscribed domains, apps and others together. */
  accountMonth: number;
  /** Delivered or bounced this month from senders no app owns, by sender address. */
  otherSenders: Array<{ sender: string; sentMonth: number }>;
  suppressions: number;
  apps: AppUsage[];
}

export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;
  /** Sends per UTC day across every app; keep it under the account's daily limit. */
  GLOBAL_DAY_CAP: string;
  /** Part of GLOBAL_DAY_CAP only priority kinds (sign-in links) may use. */
  PRIORITY_RESERVE: string;
  /** Emails a month the account's plan includes (3,000 on Workers Paid), for the usage view. */
  MONTHLY_INCLUDED?: string;
  [hook: `HOOK_${string}`]: EmailEventHook | undefined;
}

/** What an app's hook entrypoint implements. */
export interface EmailEventHook {
  onEmailEvent(event: MailEvent): Promise<unknown>;
}

export interface CallerProps {
  app?: string;
}
