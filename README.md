# mailroom

One Cloudflare Worker that sends every app's transactional email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
It holds the only `send_email` binding, enforces each app's caps, refuses addresses that bounced or complained, and hands Email Sending's bounce and complaint events back to the app that sent the message.

Apps keep their own templates.
They pass mailroom a finished email over a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/), so no app holds an API key or a binding that could send as another app.

```text
app Worker ──service binding (props.app)──▶ Mailroom.send({ kind, to, subject, text, html, key })
mailroom: app's sender allowlist ▸ kind allowlist ▸ suppression list ▸ idempotency key
          ▸ caps (recipient/day, app/day, app/month, all apps/day) ▸ env.EMAIL.send()
queue "mailroom-email-events" (Email Sending subscription per sending domain) ──▶ mailroom.queue()
          ▸ store the event ▸ suppress hard bounces and complaints ▸ app's onEmailEvent hook
```

## What it does

- **Senders and kinds per app.** Each deployment's apps file lists each app's From addresses and the kinds of email it sends: [`apps.config.ts`](apps.config.ts) for the template [`wrangler.jsonc`](wrangler.jsonc), and [`deployments/n8builds/apps.ts`](deployments/n8builds/apps.ts) for the owner's mailroom.
  The wrangler config points `mailroom:apps` at it (`alias`), and `npm test` checks it against that config.
  Only transactional kinds belong there: Cloudflare Email Service forbids marketing, bulk and cold email, and one abusive stream would put every app's mail at risk.
- **Hard caps.** Per recipient per UTC day, per app per UTC day and per UTC month, and one daily cap across all apps (`GLOBAL_DAY_CAP`, kept under the account's Email Sending limit).
  A share of the global cap (`PRIORITY_RESERVE`) is kept for priority kinds such as sign-in links, so a burst of digests never locks anyone out.
  Counters are atomic D1 upserts; a send that fails gives its units back.
- **Suppression.** A hard bounce or a complaint from any app stops every app from mailing that address, as Cloudflare's own account-wide suppression list does.
  A send Cloudflare refuses with `E_RECIPIENT_SUPPRESSED` is added too.
- **Idempotency.** A send with a `key` (a job id) goes out at most once; a retry gets `{ ok: true, duplicate: true }`.
- **Events.** A consumer on the `mailroom-email-events` queue stores every Email Sending event, matches it to the app by message id (or by sender), and calls the app's `onEmailEvent` hook for bounces, complaints, rejections and failures.
  Apps without a hook read their events with `events()`.
- **Usage.** `usage()` returns, per app, sends through mailroom today and this month against its caps, the messages Email Sending delivered or bounced this month (from the event subscription, so apps that still send with their own binding count too), and bounces, complaints and failures over 30 days, plus the account's total for the month against its 3,000 included emails (`MONTHLY_INCLUDED`).
  Recipient addresses are never in it.
  The n8builds-admin dashboard reads it through its own service binding.
  The monthly count is an upper bound: Cloudflare does not bill sends to verified Email Routing addresses (the owner's own inbox), and they are counted here.

- **Retention.** A daily cron keeps each send's recipient, kind and time for 400 days, and what became of it (its events, message id and error) for 180 days, as the privacy policies of the apps that use mailroom state.
  The suppression list is kept until the owner removes an entry, so an address that bounced for good or complained gets no more email.
  Logs carry the app, kind and outcome, never an address or any email content.

There is no public URL: `workers_dev` and preview URLs are off, there are no routes, and the `fetch` handler answers 404.

## The owner's dashboard

n8builds-admin binds a second entrypoint, `MailroomAdmin`, which no app binds:

```jsonc
"services": [{ "binding": "MAILROOM", "service": "mailroom", "entrypoint": "MailroomAdmin" }]
```

- **Reads:** `usage()`, `recentSends()` (time, app, kind, masked recipient, status), `problems()` (bounces, complaints, rejections and failures), `suppressions()` and `auditLog()`.
  Addresses come back masked (`jo***@gmail.com`), inside SMTP replies too, and no email content is ever returned or stored.
- **Changes**, each taking the signed-in owner as `actor` and written to `audit_log` in the same batch:
  - `removeSuppression(id, actor)` lets mailroom mail an address again. Cloudflare keeps its own account-wide suppression list, so a hard bounce also has to be cleared there (Compute, Email Service, Suppressions) before mail reaches it.
  - `setPaused(app, paused, actor)`: a paused app's sends are refused with `paused` (retryable) until it is resumed.
  - `setDailyCap(app, cap, actor)` replaces the app's daily cap from the apps file, from 0 up to `GLOBAL_DAY_CAP`; `null` puts the default back.

## Calling it from an app

Add a service binding in the app's `wrangler.jsonc`; `props.app` is its id in mailroom's apps file:

```jsonc
"services": [
  { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom", "props": { "app": "prpost" } }
]
```

```ts
const result = await env.MAILROOM.send({
  kind: "digest",
  to: "reader@example.com",
  subject: "This week",
  text: "Plain text body",
  html: "<p>HTML body</p>",
  fromName: "PR Post",
  headers: { "List-Unsubscribe": "<https://example.com/u/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  key: "digest-2026-11-10-reader",
});
if (!result.ok) {
  // result.code: suppressed, cap_app_day, rate_limited, ...; retry later only when result.retryable.
}
```

`send()` never throws for a refused send.
The result codes are in [`src/types.ts`](src/types.ts).

To receive bounces and complaints, export a hook entrypoint from the app and add its binding to mailroom's `wrangler.jsonc` under the name in the app's `hook` field:

```ts
export class EmailEvents extends WorkerEntrypoint<Env> {
  async onEmailEvent(event: MailEvent) {
    // event.type: bounced | complained | rejected | failed; event.suppressed is true when mailroom stopped mailing the address.
  }
}
```

```jsonc
"services": [{ "binding": "HOOK_PRPOST", "service": "pull-request-post", "entrypoint": "EmailEvents" }]
```

A hook that throws is retried by the queue with backoff, up to 8 times, then the event goes to `mailroom-email-events-dlq`.
An event is passed to the hook once even when the queue delivers it twice.

## Moving an app onto mailroom

Several apps already send through their own `send_email` binding with a local daily cap (an `email_sends` count table and `EMAIL_DAILY_CAP`).
The move keeps exactly one effective limit in force at every moment: never two different limits, never none.

1. **Match the caps first.** In mailroom's apps file, set the app's `caps.day` to the app's current `EMAIL_DAILY_CAP`, and `caps.month` no lower than 31 times that (the longest month), so mailroom adds no new, tighter limit.
   Deploy mailroom.
2. **Switch the transport behind a flag.** One app PR adds the `MAILROOM` service binding and an `EMAIL_VIA` variable (`binding`, the default, or `mailroom`).
   With `mailroom`, the app sends through `env.MAILROOM.send()` and keeps its local cap check and `email_sends` count exactly as before.
   Both limits now hold the same number and count the same sends, so the effective limit is unchanged.
   The app maps mailroom's `cap_*` codes to its own existing "daily cap" outcome.
3. **Verify.** Set `EMAIL_VIA=mailroom` and deploy.
   Test emails of each kind reach the owner's inbox, and one bounce reaches the app (its hook or `events()`).
   Flipping back to `binding` is a variable change, with the local cap still in force.
4. **Remove the old path.** A second app PR removes the app's `send_email` binding, the direct-send code, `EMAIL_VIA`, `EMAIL_DAILY_CAP` and the local cap check.
   mailroom has been enforcing the same cap since step 2, so there is no gap.
   The `email_sends` table can stay for history and is dropped in a later migration.
5. **Tune.** Only now change the app's caps in mailroom, for example to give it a share of the account's 3,000 included emails a month.

mailroom's `send_email` binding already allows every app's sender; its `wrangler.jsonc` gains the app's `HOOK_*` binding once the app exports a hook.

## Setup

The Cloudflare resources (already created for the n8builds account):

```bash
npx wrangler d1 create mailroom                       # put the id in the deployment's wrangler.jsonc
npx wrangler queues create mailroom-email-events
npx wrangler queues create mailroom-email-events-dlq
npm run deploy -- deployments/n8builds/wrangler.jsonc # applies migrations, then deploys
# One subscription per sending domain:
npx wrangler queues subscription create mailroom-email-events --source email.sending \
  --zone-id <zone id> --domain n8builds.dev --name mailroom-n8builds-dev \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
```

A new sending domain needs three things: onboarding for Email Sending in the dashboard, its senders in the apps file and in the `send_email` binding's `allowed_sender_addresses`, and its own event subscription.

## Development

```bash
npm install
npm test            # workerd and a local D1; the send binding is a fake, nothing is sent
npm run typecheck
npm run check:deploy
```

## License

MIT
