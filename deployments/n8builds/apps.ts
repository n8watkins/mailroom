/**
 * The owner's apps on the n8builds.dev mailroom (deployments/n8builds/wrangler.jsonc).
 * What each field means: src/apps.ts. Every exact sender must also be in that
 * config's send_email allowed_sender_addresses; `npm test` checks it.
 */
import type { Apps } from "../../src/apps";

export const APPS = {
  // PR Post: the paper Worker (n8watkins/pr-post) sends the digest and Who to follow
  // emails for its jobs and receives bounces at its EmailEvents entrypoint.
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
  // Its kinds are the platform's three streams (open-ping platform/src/mail.ts).
  "openping-hosted": {
    senders: [],
    kinds: ["signin", "account", "tenant"],
    priority: ["signin"],
    caps: { day: 200, month: 2000, recipientDay: 40 },
  },
} satisfies Apps;
