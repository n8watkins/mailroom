/**
 * The apps that may send through mailroom, and what each may send.
 *
 * The list itself lives in your deployment's apps file, which the wrangler
 * config points `mailroom:apps` at (`"alias"`): `apps.config.ts` for the
 * root `wrangler.jsonc`. See the README, "Configure your apps".
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
 * - `hook`: the name of the service binding in the wrangler config that
 *   receives this app's bounce and complaint events (`onEmailEvent`). Apps
 *   without a hook read them with `events()`.
 */
import { APPS as CONFIGURED } from "mailroom:apps";

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

export type Apps = Record<string, AppConfig>;

export const APPS: Apps = CONFIGURED;

/** The app that owns a From address, for events that can't be matched by message id. */
export function appForSender(sender: string, apps: Apps = APPS): string | undefined {
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

/** What `checkApps` compares the apps against: the deployment's wrangler config. */
export interface DeploymentBindings {
  /** The `send_email` binding's `allowed_sender_addresses`, or undefined when it allows any sender. */
  allowedSenders?: string[];
  /** The names of the deployment's service bindings. */
  services: string[];
}

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RULE_RE = /^@[^\s@]+\.[^\s@]+$/;

/**
 * Everything wrong with a deployment's apps, as sentences; empty when it is
 * fine. The config test runs it on every deployment in the repository, so a
 * mistake fails `npm test` instead of refusing sends after a deploy.
 */
export function checkApps(apps: Apps, bindings: DeploymentBindings): string[] {
  const problems: string[] = [];
  const allowed = bindings.allowedSenders?.map((s) => s.toLowerCase());
  const owners = new Map<string, string>();
  for (const [id, app] of Object.entries(apps)) {
    const at = (what: string) => problems.push(`${id}: ${what}`);
    if (!APP_ID_RE.test(id)) at("the id must be lowercase letters, digits and dashes.");
    if (!Array.isArray(app.senders)) {
      at("`senders` must be a list.");
    } else {
      for (const sender of app.senders) {
        const s = sender.toLowerCase();
        if (s.startsWith("@") ? !DOMAIN_RULE_RE.test(s) : !ADDRESS_RE.test(s)) at(`"${sender}" is not an address or an "@domain" rule.`);
        if (!s.startsWith("@") && allowed && !allowed.includes(s)) at(`"${sender}" is missing from the send_email binding's allowed_sender_addresses.`);
        const owner = owners.get(s);
        if (owner) at(`"${sender}" is also a sender of ${owner}; each sender belongs to one app.`);
        owners.set(s, id);
      }
    }
    if (!Array.isArray(app.kinds) || app.kinds.length === 0) at("`kinds` must list at least one kind.");
    for (const kind of app.priority ?? []) {
      if (!app.kinds?.includes(kind)) at(`priority kind "${kind}" is not one of its kinds.`);
    }
    const caps = app.caps ?? ({} as AppCaps);
    for (const key of ["day", "month", "recipientDay"] as const) {
      if (!Number.isInteger(caps[key]) || caps[key] < 0) at(`caps.${key} must be a whole number, 0 or more.`);
    }
    if (caps.recipientDay > caps.day || caps.day > caps.month) at("caps must keep recipientDay <= day <= month.");
    if (app.hook !== undefined) {
      if (!app.hook.startsWith("HOOK_")) at(`hook "${app.hook}" must be a binding name starting with HOOK_.`);
      else if (!bindings.services.includes(app.hook)) at(`hook "${app.hook}" is not a service binding in the wrangler config.`);
    }
  }
  return problems;
}
