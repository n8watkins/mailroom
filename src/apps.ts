/**
 * Every app that may send through mailroom, and what it may send.
 *
 * An app is identified by the `props.app` of its service binding (set in the
 * calling Worker's wrangler config, which only someone who can deploy that
 * Worker can change), never by anything in the request.
 *
 * - `senders`: the From addresses the app may use. The first is its default.
 *   An entry that starts with "@" allows any address on that domain.
 * - `kinds`: what the app sends. Transactional kinds only: Cloudflare Email
 *   Service forbids marketing, bulk and cold email, and one abusive stream
 *   would put every app's mail at risk.
 * - `priority`: kinds that keep a reserved share of the account's daily limit
 *   (sign-in links), so a burst of digests can never lock people out.
 * - `caps`: hard limits per UTC day and per UTC calendar month for the app,
 *   and per recipient per UTC day.
 * - `hook`: the name of the service binding in wrangler.jsonc that receives
 *   this app's bounce and complaint events (`onEmailEvent`). Apps without a
 *   hook read them with `events()`.
 */

export interface AppCaps {
  day: number;
  month: number;
  recipientDay: number;
}

export interface AppConfig {
  senders: string[];
  kinds: string[];
  priority?: string[];
  caps: AppCaps;
  hook?: string;
}

export const APPS: Record<string, AppConfig> = {
  prpost: {
    senders: ["prpost@n8builds.dev"],
    kinds: ["digest", "follow"],
    caps: { day: 40, month: 400, recipientDay: 6 },
    hook: "HOOK_PRPOST",
  },
  cutelyaskme: {
    senders: ["cutelyaskme@n8builds.dev"],
    kinds: ["invite", "plan-locked", "spot-ready", "date-canceled"],
    caps: { day: 100, month: 1000, recipientDay: 10 },
  },
  "n8builds-web": {
    senders: ["contact@n8builds.dev"],
    kinds: ["contact-notice", "contact-reply", "quote-notice", "quote-reply", "waitlist"],
    caps: { day: 60, month: 600, recipientDay: 30 },
  },
  nettrailers: {
    senders: ["nettrailers@n8builds.dev"],
    kinds: ["signin", "reply", "digest", "trending", "admin"],
    priority: ["signin"],
    caps: { day: 150, month: 2000, recipientDay: 10 },
  },
  wren: {
    senders: ["wren@n8builds.dev"],
    kinds: ["signin"],
    priority: ["signin"],
    caps: { day: 60, month: 600, recipientDay: 6 },
  },
  keysready: {
    senders: ["keysready@n8builds.dev"],
    kinds: ["signin"],
    priority: ["signin"],
    caps: { day: 60, month: 600, recipientDay: 6 },
  },
  portfoliorank: {
    senders: ["portfoliorank@n8builds.dev"],
    kinds: ["report", "report-link", "owner-alert"],
    caps: { day: 60, month: 600, recipientDay: 6 },
  },
  openping: {
    senders: ["support@n8builds.dev"],
    kinds: ["alert", "summary", "report", "signin", "waitlist"],
    priority: ["signin"],
    caps: { day: 150, month: 1500, recipientDay: 40 },
  },
  // OpenPing Hosted: sign-in codes, account emails and each tenant's alerts.
  // It sends from the Hosted domain, which is added here once it is bought and
  // onboarded for Email Sending; until then every send is refused.
  "openping-hosted": {
    senders: [],
    kinds: ["signin", "account", "alert", "summary", "report"],
    priority: ["signin"],
    caps: { day: 200, month: 2000, recipientDay: 40 },
  },
};

/** The app that owns a From address, for events that can't be matched by message id. */
export function appForSender(sender: string, apps: Record<string, AppConfig> = APPS): string | undefined {
  const address = sender.trim().toLowerCase();
  for (const [id, app] of Object.entries(apps)) {
    if (app.senders.some((allowed) => matchesSender(allowed, address))) return id;
  }
  return undefined;
}

export function matchesSender(allowed: string, address: string): boolean {
  const rule = allowed.toLowerCase();
  return rule.startsWith("@") ? address.endsWith(rule) && address.indexOf("@") === address.length - rule.length : rule === address;
}
