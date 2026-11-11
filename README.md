# mailroom

<p align="center">
  <img src="docs/board.svg" width="320" alt="A cork board with envelopes pinned to it, joined by red string">
  <br>
  <sub>Every email accounted for. <a href="https://knowyourmeme.com/memes/pepe-silvia">No Pepe Silvia required.</a></sub>
</p>

One Cloudflare Worker that sends email for all your apps through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Each app gets its own caps (per recipient, per day, per month), and shared caps keep the whole account under its daily limit and inside the emails its plan includes each month, so Email Sending never bills.
A suppression list stops every app from mailing an address that bounced or complained.
Idempotency keys make retries safe, and bounce and complaint events go back to the app that sent the message.
An admin entrypoint lets a dashboard see what was sent, pause an app or change its cap.

Apps keep their own templates.
They hand mailroom a finished email over a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/), so no app holds an API key or a binding that could send as another app.

```text
app Worker ──service binding (props.app)──▶ Mailroom.send({ kind, to, subject, text, html, key })
mailroom: app's sender allowlist ▸ kind allowlist ▸ suppression list ▸ idempotency key
          ▸ caps (recipient/day, app/day, app/month, all apps/day, all apps/month) ▸ env.EMAIL.send()
queue "mailroom-email-events" (Email Sending subscription per sending domain) ──▶ mailroom.queue()
          ▸ store the event ▸ suppress hard bounces and complaints ▸ app's onEmailEvent hook
```

## Who it's for

You run a few apps on Cloudflare Workers, and each one needs to send a little email: sign-in links, receipts, notices, a weekly digest.
You'd rather not hand every app its own email binding, its own cap and its own bounce handling.

It's not for everything:

- **Transactional email only.** Cloudflare Email Service forbids marketing, bulk and cold email, and one abusive stream would put every app's mail at risk.
  Newsletters belong on a marketing platform.
- **Your sending domains must be on Cloudflare**, onboarded for Email Sending.
- **Low to medium volume.** Every send is a few D1 writes, and the account has a daily sending limit (mine is 1,000 a day).
  Thousands of emails a day is fine.
  Millions is not what this is for.
- **Workers only.** Apps reach mailroom through service bindings, so they have to be Workers in the same Cloudflare account.

## How I use it

I run it for my own apps.
It sends everything they mail out:

- **[n8builds.dev](https://n8builds.dev)**: contact form and quote request notices, my replies, and waitlist confirmations.
- **[PR Post](https://github.com/n8watkins/pr-post)**: the weekly digest and "who to follow" emails.
  Its bounces come back to its own hook.
- **A handful of smaller apps**: sign-in links, alerts and reports.

Each app has its own sender and caps, and sign-in links keep a reserved share of the day so a busy digest never locks anyone out.

My private admin dashboard has a Mailroom page on top of the admin entrypoint: the month at a glance against the 3,000 included emails, recent sends, bounces and complaints, the suppression list, every app's caps with pause and daily cap controls, and an audit log of every change.

My live config is in [`deployments/n8builds/`](deployments/n8builds/), if you want a real example.

## Quick start

### What you need

- A Cloudflare account on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), which Email Sending needs (3,000 emails a month included).
- A domain on Cloudflare, onboarded for [Email Sending](https://developers.cloudflare.com/email-service/).
- Node.js 22 or newer.

### 1. Clone and install

```bash
git clone https://github.com/n8watkins/mailroom.git
cd mailroom
npm install
npm test   # runs in workerd with a local D1; nothing is sent
```

### 2. Create the Cloudflare resources

```bash
npx wrangler login
npx wrangler email sending enable yourdomain.com
npx wrangler d1 create mailroom                     # copy the database id
npx wrangler queues create mailroom-email-events
npx wrangler queues create mailroom-email-events-dlq
```

Put the database id in [`wrangler.jsonc`](wrangler.jsonc) in place of `<your D1 database id>`.
If your login has more than one account, add `"account_id"` there too, or set `CLOUDFLARE_ACCOUNT_ID`.

### 3. Define your apps

Your apps live in [`apps.config.ts`](apps.config.ts):

```ts
export const APPS = {
  app: {
    senders: ["hello@yourdomain.com"],          // From addresses; the first is the default
    kinds: ["signin", "welcome"],               // what it sends
    priority: ["signin"],                       // kinds that keep a reserved share of the day
    caps: { day: 200, month: 3000, recipientDay: 10 },
  },
} satisfies Apps;
```

Then list every sender in the `send_email` binding's `allowed_sender_addresses` in `wrangler.jsonc`.
An `"@yourdomain.com"` sender lets an app use any address on that domain; the binding still has to allow each one.
`npm test` checks your apps against `wrangler.jsonc`: senders allowed, hooks bound, caps in order.

Set `GLOBAL_DAY_CAP` under your account's Email Sending daily limit (it's in the dashboard).
Set `GLOBAL_MONTH_CAP` under the emails your plan includes (2,500 against the 3,000 on Workers Paid), and keep your apps' `month` caps adding up to at most that: `npm test` fails when they don't.

### 4. Deploy

```bash
npm run check:deploy   # dry run
npm run deploy         # applies the D1 migrations, then deploys
```

`npm run deploy` refuses to run while `wrangler.jsonc` still has a `<your ...>` placeholder.

### 5. Subscribe to delivery events

One subscription per sending domain, so bounces and complaints reach mailroom:

```bash
npx wrangler queues subscription create mailroom-email-events --source email.sending \
  --zone-id <zone id> --domain yourdomain.com --name mailroom-yourdomain \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
```

### 6. Send from an app

In the app's `wrangler.jsonc`, bind the `Mailroom` entrypoint and name the app with `props.app`:

```jsonc
"services": [
  { "binding": "MAILROOM", "service": "mailroom", "entrypoint": "Mailroom", "props": { "app": "app" } }
]
```

Then send:

```ts
const result = await env.MAILROOM.send({
  kind: "signin",
  to: "reader@example.com",
  subject: "Your sign-in link",
  text: "Plain text body",
  html: "<p>HTML body</p>",
  fromName: "My App",
  key: "signin-8f2c41", // optional: the same key never sends twice
});
if (!result.ok) {
  // result.code: suppressed, cap_app_day, rate_limited, ...
  // Retry later only when result.retryable.
}
```

`send()` never throws for a refused send.
The request, result and event types are in [`src/types.ts`](src/types.ts); copy what you need into the app.
A minimal binding type:

```ts
interface Env {
  MAILROOM: {
    send(request: SendRequest): Promise<SendResult>;
    isSuppressed(address: string): Promise<boolean>;
    events(opts?: { since?: number; limit?: number }): Promise<Array<MailEvent & { receivedAt: number }>>;
  };
}
```

### Get bounces and complaints back

Either poll `events()` with the last `receivedAt` you saw, or export a hook from the app:

```ts
export class EmailEvents extends WorkerEntrypoint<Env> {
  async onEmailEvent(event: MailEvent) {
    // event.type: bounced | complained | rejected | failed
    // event.suppressed is true when mailroom stopped mailing the address.
  }
}
```

Deploy the app first, then bind its hook in mailroom's `wrangler.jsonc` and name it in the app's `hook`:

```jsonc
"services": [{ "binding": "HOOK_SHOP", "service": "my-shop", "entrypoint": "EmailEvents" }]
```

A hook that throws is retried with backoff, up to 8 times, then the event goes to the dead-letter queue.
Each event reaches the hook once, even when the queue delivers it twice.

### Run more than one deployment

The root `wrangler.jsonc` and `apps.config.ts` are the template.
To keep a real deployment next to it, put its own pair in `deployments/<name>/` (the wrangler config points `mailroom:apps` at its `apps.ts` with `alias`), and deploy it by path:

```bash
npm run deploy -- deployments/<name>/wrangler.jsonc
```

`npm test` and `npm run check:deploy` cover every deployment in the folder.
That's how my own mailroom is set up.

## How it works

### Caps

Every send checks five counters, all atomic D1 upserts:

- **Per recipient per UTC day**, per app (`recipientDay`), so a bug can't flood one inbox.
- **Per app per UTC day and per UTC month** (`day`, `month`).
- **All apps per UTC day** (`GLOBAL_DAY_CAP`), kept under the account's Email Sending limit.
  The last `PRIORITY_RESERVE` of it is only for `priority` kinds, such as sign-in links.
- **All apps per month** (`GLOBAL_MONTH_CAP`, 2,500 when unset), so the account never sends past the 3,000 emails Workers Paid includes and never pays for email.
  The last `PRIORITY_MONTH_RESERVE` (300 when unset) is only for `priority` kinds, so sign-in links keep working for the rest of the month after the other email stops.
  At the cap a send is refused with `cap_global_month`.

The monthly cap counts a rolling window of the last 32 UTC days, today included, not the calendar month.
Cloudflare resets the included emails with the account's billing cycle, which can start on any day and at any hour.
With a calendar-month cap, a cycle that starts mid-month would see what is left of one month's cap and all of the next, up to twice the cap.
A billing cycle lasts at most 31 days, so it touches at most 32 UTC days, all inside one window: no cycle can hold more than the cap, whatever its start.
The 500 below 3,000 is a buffer for what mailroom can't count, such as an app that still sends with its own binding.

Each app's `month` cap is its slice of `GLOBAL_MONTH_CAP`, and its `day` cap its slice of `GLOBAL_DAY_CAP`: `npm test` fails when the slices add up to more, so one app can't spend another's share.

Sends to verified Email Routing destination addresses (your own inbox) are free and don't count toward Cloudflare's quota or daily limit.
mailroom counts them anyway: it can't tell whether an address is still verified, Cloudflare doesn't always report them, and counting a free send only leaves one unused, while missing a paid one could cost money.

### Cap alerts

mailroom emails you as the all-app caps fill up: at 70, 85, 95 and 100% of `GLOBAL_MONTH_CAP`, and when `GLOBAL_DAY_CAP` is reached.
A refusal by a global cap counts as reaching it, even while the sign-in reserve is left.
Each alert says which cap, how much is used, the top apps in that period and a link to `ADMIN_URL`, and goes out once: monthly thresholds once per 32-day window, the daily cap once per UTC day.
The admin shows "Needs attention" from the first threshold, 70% (`usage().globalMonth.attention`, with the thresholds reached in `alerts`).

- `ALERT_TO` is your address. Set it as a secret (`npx wrangler secret put ALERT_TO -c <config>`) so it stays out of the repository, and make it a verified Email Routing destination address so alerts are free. While it's unset, thresholds are still recorded for the admin, but nobody is emailed.
- `ALERT_FROM` is the sender, on a domain you send from; add it to the `send_email` binding's `allowed_sender_addresses`, and give it to no app.
- Alerts never pass through the global caps, so a full cap can't block the alert about it. Their own limits, 10 a day and 40 in any 32 days, keep a bug from looping, and they're recorded in `sends` as app `mailroom`, kind `alert`.

A send that fails gives its units back.
A refused send returns a `cap_*` code and says whether retrying later can help.

### Suppression list

A hard bounce or a complaint from any app stops every app from mailing that address, the same way Cloudflare's own account-wide suppression list works.
A send Cloudflare refuses with `E_RECIPIENT_SUPPRESSED` is added too.
Entries stay until you remove one from the admin.

### Idempotency

A send with a `key` (a job id, say) goes out at most once per app.
A retry gets `{ ok: true, duplicate: true }`, and a retry while the first is still sending gets `in_progress`.

### Events

A consumer on the `mailroom-email-events` queue stores every Email Sending event.
It matches each event to the app by message id, or by sender when the message didn't go through mailroom, and calls that app's hook for bounces, complaints, rejections and failures.

`usage()` counts each app's sends today and this month against its caps, plus what Email Sending delivered or bounced this month, so apps that still send with their own binding show up too.
`globalMonth` holds the all-app monthly window: `used`, `cap`, `priorityReserve`, `windowStart`, `warnAt`, `attention` with `attentionSince`, and the `alerts` sent this window; `globalDayCappedAt` says when today's daily cap was reached.
Sends to verified Email Routing addresses (your own inbox) are free, and Cloudflare does not always publish an event for them, so the event-based monthly count may miss some; mailroom's own day and month counters, which its caps use, always include them.

### Retention

A daily cron keeps each send's recipient, kind and time for 400 days, and what became of it (events, message id, error) for 180 days.
Change `SENDS_KEEP_MS` and `STATUS_KEEP_MS` in [`src/index.ts`](src/index.ts) to match your privacy policy.
Logs carry the app, kind and outcome, never an address or any email content.

### The admin entrypoint

A dashboard binds a second entrypoint, `MailroomAdmin`, which no app should bind:

```jsonc
"services": [{ "binding": "MAILROOM", "service": "mailroom", "entrypoint": "MailroomAdmin" }]
```

- **Reads:** `usage()`, `recentSends()`, `problems()` (bounces, complaints, rejections, failures), `suppressions()` and `auditLog()`.
  Addresses come back masked (`jo***@gmail.com`), inside SMTP replies too, and email content is never stored.
- **Changes** take the signed-in user as `actor` and are written to `audit_log` in the same batch:
  - `removeSuppression(id, actor)` lets mailroom mail an address again.
    Cloudflare keeps its own suppression list, so clear a hard bounce there too.
  - `setPaused(app, paused, actor)`: a paused app's sends are refused with `paused` until it's resumed.
  - `setDailyCap(app, cap, actor)` overrides the app's daily cap, from 0 up to `GLOBAL_DAY_CAP`; `null` puts the default back.

### The trust model

mailroom has no public URL: `workers_dev` and preview URLs are off, there are no routes, and `fetch` answers 404.
The only way in is a service binding, and Cloudflare lets any Worker in the same account bind to any other.

So the account is the boundary.
Anyone who can deploy a Worker to your account can bind to `Mailroom` with any `props.app`, or to `MailroomAdmin`.
`props.app` stops one of your apps from sending as another by mistake, not an attacker with deploy access.
If people you don't fully trust can deploy Workers in the account, run mailroom in its own account.

## Moving an existing app onto mailroom

Say an app already sends through its own `send_email` binding with a local daily cap (an `email_sends` count table and `EMAIL_DAILY_CAP`).
The move keeps exactly one effective limit in force at every moment: never two different limits, never none.

1. **Match the caps first.** In mailroom's apps file, set the app's `caps.day` to its current `EMAIL_DAILY_CAP`, and `caps.month` to what it sends in a month with room to spare, within what's left of `GLOBAL_MONTH_CAP`, so mailroom adds no new limit the app would hit.
   Deploy mailroom.
2. **Switch the transport behind a flag.** One app PR adds the `MAILROOM` binding and an `EMAIL_VIA` variable (`binding`, the default, or `mailroom`).
   With `mailroom`, the app sends through `env.MAILROOM.send()` and keeps its local cap check and count exactly as before.
   Both limits now hold the same number and count the same sends, so the effective limit is unchanged.
   The app maps mailroom's `cap_*` codes to its own "daily cap" outcome.
3. **Verify.** Set `EMAIL_VIA=mailroom` and deploy.
   Send a test email of each kind to your own inbox, and check one bounce reaches the app.
   Going back is a variable change, with the local cap still in force.
4. **Remove the old path.** A second app PR removes the app's `send_email` binding, the direct-send code, `EMAIL_VIA`, `EMAIL_DAILY_CAP` and the local cap check.
   mailroom has enforced the same cap since step 2, so there's no gap.
5. **Tune.** Only now change the app's caps in mailroom.

## Limits and caveats

- **Cloudflare Email Service is new.** Email Sending is in open beta and still changing: event shapes, limits and pricing may move under you.
  Check the [docs](https://developers.cloudflare.com/email-service/) before you rely on a detail here.
- **The dead-letter queue isn't watched yet.** An event whose hook keeps failing lands in `mailroom-email-events-dlq` and stays there until you look.
- **Caps are UTC.** Days and months roll over at midnight UTC, not your local midnight.
- **One recipient per send.** No CC, BCC or batch sends; call `send()` once per person.
- **No templates, no scheduling, no open or click tracking.** Apps render their own email and decide when to send it.
- **Pricing.** Workers Paid includes 3,000 emails a month, then $0.35 per 1,000 (`MONTHLY_INCLUDED` drives the usage view only; `GLOBAL_MONTH_CAP` is what keeps you under it).
- **It's run by one person.** I fix what breaks for my apps first.
  Issues and PRs are welcome, but there's no SLA.

## Development

```bash
npm install
npm test               # workerd and a local D1; the send binding is a fake
npm run typecheck
npm run check:deploy   # dry run of every deployment
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
