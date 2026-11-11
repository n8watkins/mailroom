/**
 * Your apps: who may send through this mailroom, and what.
 * The root wrangler.jsonc points `mailroom:apps` here. What each field means:
 * src/apps.ts. `npm test` checks this list against wrangler.jsonc.
 *
 * The key (`app`, `shop`) is the app's id: the `props.app` in the service
 * binding of the Worker that sends as it.
 */
import type { Apps } from "./src/apps";

export const APPS = {
  // A web app: sign-in links (kept a share of the daily limit) and a welcome email.
  app: {
    senders: ["hello@example.com"],
    kinds: ["signin", "welcome"],
    priority: ["signin"],
    caps: { day: 200, month: 3000, recipientDay: 10 },
  },
  // A shop: receipts and shipping updates. Add `hook: "HOOK_SHOP"` once the
  // shop exports an EmailEvents entrypoint and wrangler.jsonc binds it.
  shop: {
    senders: ["orders@example.com"],
    kinds: ["receipt", "shipping"],
    caps: { day: 100, month: 1500, recipientDay: 5 },
  },
} satisfies Apps;
