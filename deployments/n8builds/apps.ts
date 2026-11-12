/**
 * The owner's apps on the n8builds.dev mailroom (deployments/n8builds/wrangler.jsonc).
 * What each field means: src/apps.ts. Every exact sender must also be in that
 * config's send_email allowed_sender_addresses; `npm test` checks it.
 *
 * Each app's `month` cap is its slice of GLOBAL_MONTH_CAP (2,500, under the
 * 3,000 Workers Paid includes): the slices add up to at most that, which
 * `npm test` checks too, so one app can't spend another's share.
 */
import type { Apps } from "../../src/apps";

export const APPS = {
  // PR Post: the paper Worker (n8watkins/pr-post) sends the digest and Who to follow
  // emails for its jobs and receives bounces at its EmailEvents entrypoint.
  prpost: {
    senders: ["prpost@n8builds.dev"],
    kinds: ["digest", "follow"],
    caps: { day: 40, month: 300, recipientDay: 6 },
    hook: "HOOK_PRPOST",
  },
  cutelyaskme: {
    senders: ["cutelyaskme@n8builds.dev"],
    kinds: ["invite", "plan-locked", "spot-ready", "date-canceled"],
    caps: { day: 100, month: 300, recipientDay: 10 },
  },
  // announce: project announcements to confirmed waitlist people (n8builds-admin Announcements page).
  "n8builds-web": {
    senders: ["contact@n8builds.dev"],
    kinds: ["contact-notice", "contact-reply", "quote-notice", "quote-reply", "waitlist", "announce"],
    caps: { day: 60, month: 200, recipientDay: 30 },
  },
  nettrailers: {
    senders: ["nettrailers@n8builds.dev"],
    kinds: ["signin", "reply", "digest", "trending", "admin"],
    priority: ["signin"],
    caps: { day: 150, month: 400, recipientDay: 10 },
  },
  wren: {
    senders: ["wren@n8builds.dev"],
    kinds: ["signin"],
    priority: ["signin"],
    caps: { day: 60, month: 150, recipientDay: 6 },
  },
  keysready: {
    senders: ["keysready@n8builds.dev"],
    kinds: ["signin"],
    priority: ["signin"],
    caps: { day: 60, month: 150, recipientDay: 6 },
  },
  portfoliorank: {
    senders: ["portfoliorank@n8builds.dev"],
    kinds: ["report", "report-link", "owner-alert"],
    caps: { day: 60, month: 150, recipientDay: 6 },
  },
  openping: {
    senders: ["support@n8builds.dev"],
    kinds: ["alert", "summary", "report", "signin", "waitlist"],
    priority: ["signin"],
    caps: { day: 150, month: 450, recipientDay: 40 },
  },
  // OpenPing Hosted: sign-in codes, account emails and each tenant's alerts.
  // It sends from the Hosted domain, which is added here once it is bought and
  // onboarded for Email Sending; until then every send is refused.
  // Its kinds are the platform's three streams (open-ping platform/src/mail.ts).
  "openping-hosted": {
    senders: [],
    kinds: ["signin", "account", "tenant"],
    priority: ["signin"],
    // Lowered to make room for Tend and n8builds-news; restore at Hosted launch.
    caps: { day: 100, month: 100, recipientDay: 40 },
  },
  // The n8builds.dev blog newsletter (n8builds-web): a confirm-your-address email
  // and a weekly digest, sent only in weeks with a post.
  "n8builds-news": {
    senders: ["news@n8builds.dev"],
    kinds: ["confirm", "digest"],
    caps: { day: 40, month: 150, recipientDay: 3 },
  },
  // Tend (n8watkins/tend, tend.n8builds.dev): sign-in links and reminders.
  tend: {
    senders: ["tend@n8builds.dev"],
    kinds: ["signin", "reminder"],
    priority: ["signin"],
    caps: { day: 30, month: 150, recipientDay: 8 },
  },
} satisfies Apps;
