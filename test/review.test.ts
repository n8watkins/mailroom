import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "../src/index";
import { eventsFor, handleEvent, type EmailSendingEvent } from "../src/events";
import { sendFor } from "../src/send";
import { fakeEmail, resetDb, testEnv, TEST_APPS } from "./helpers";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 24 * 3600_000;
const base = { kind: "digest", to: "reader@example.net", subject: "Weekly", text: "Hello" };

function setup(overrides: Record<string, unknown> = {}) {
  const email = fakeEmail();
  const e = testEnv({ EMAIL: email as unknown as SendEmail, ...overrides });
  const send = (req: Record<string, unknown>, app = "alpha") => sendFor(app, req as never, { env: e, apps: TEST_APPS, now: () => NOW });
  return { email, send };
}

describe("send input checks", () => {
  beforeEach(resetDb);

  it("refuses a From that is not one plain address, even on a domain rule", async () => {
    const { email, send } = setup();
    expect(await send({ ...base, from: "evil x@notify.example.test" })).toMatchObject({ ok: false });
    expect(await send({ ...base, from: "a\r\nbcc: b@notify.example.test" })).toMatchObject({ ok: false });
    expect(await send({ ...base, from: 42 })).toMatchObject({ ok: false, code: "invalid" });
    expect(email.sent).toHaveLength(0);
  });

  it("refuses a display name, headers or attachments that are not well formed", async () => {
    const { email, send } = setup();
    expect(await send({ ...base, fromName: "Alpha\r\nBcc: x@y.z" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, fromName: 7 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, headers: { "X-Job": "a\r\nBcc: x@y.z" } })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, headers: { "Bad Name": "v" } })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, headers: { "X-N": 5 } })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, headers: "List-Unsubscribe: x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send({ ...base, attachments: "nope" })).toMatchObject({ ok: false, code: "invalid" });
    expect(email.sent).toHaveLength(0);
    expect(
      await send({ ...base, fromName: "Alpha", headers: { "List-Unsubscribe": "<https://a.test/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }),
    ).toMatchObject({ ok: true });
  });

  it("returns a retryable result instead of throwing when the database is down", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("db down");
      },
    } as unknown as D1Database;
    const { email, send } = setup({ DB: brokenDb });
    expect(await send(base)).toMatchObject({ ok: false, code: "unavailable", retryable: true });
    expect(email.sent).toHaveLength(0);
  });
});

describe("events cursor", () => {
  beforeEach(resetDb);

  it("pages through events that arrived in the same millisecond without skipping any", async () => {
    const e = testEnv();
    for (const n of [1, 2, 3]) {
      const ev = {
        type: "cf.email.sending.message.delivered",
        payload: { eventId: `tie-${n}`, messageId: `m${n}`, sender: "beta@example.test", recipient: `r${n}@example.net` },
      } as EmailSendingEvent;
      await handleEvent(ev, { env: e, apps: TEST_APPS, now: () => NOW });
    }
    const first = await eventsFor(env.DB, "beta", { limit: 2 });
    const rest = await eventsFor(env.DB, "beta", { since: first[first.length - 1]!.receivedAt, limit: 2 });
    expect([...first, ...rest].map((x) => x.eventId)).toEqual(["tie-1", "tie-2", "tie-3"]);
  });

  it("keeps the complaint type as the reason", async () => {
    const e = testEnv();
    const ev = await handleEvent(
      { type: "cf.email.sending.message.complained", payload: { eventId: "c1", sender: "beta@example.test", recipient: "x@example.net", complaint: { type: "abuse" } } } as EmailSendingEvent,
      { env: e, apps: TEST_APPS, now: () => NOW },
    );
    expect(ev?.reason).toBe("abuse");
  });
});

describe("retention", () => {
  beforeEach(resetDb);

  it("keeps recipient, kind and time for 400 days but delivery status only for 180", async () => {
    const insert = (id: number, at: number) =>
      env.DB.prepare(
        "INSERT INTO sends (id, app, kind, sender, recipient, idem_key, status, message_id, error, created_at, updated_at) VALUES (?, 'alpha', 'digest', 'alpha@example.test', 'r@example.net', NULL, 'failed', 'mid', 'suppressed', ?, ?)",
      )
        .bind(id, at, at)
        .run();
    await insert(1, NOW - 10 * DAY);
    await insert(2, NOW - 200 * DAY);
    await insert(3, NOW - 401 * DAY);
    await env.DB.prepare("INSERT INTO email_events (event_id, type, received_at) VALUES ('old', 'bounced', ?), ('new', 'bounced', ?)")
      .bind(NOW - 181 * DAY, NOW - 10 * DAY)
      .run();
    await cleanup(testEnv(), NOW);
    const sends = await env.DB.prepare("SELECT id, recipient, kind, message_id, error FROM sends ORDER BY id").all();
    expect(sends.results).toEqual([
      { id: 1, recipient: "r@example.net", kind: "digest", message_id: "mid", error: "suppressed" },
      { id: 2, recipient: "r@example.net", kind: "digest", message_id: null, error: null },
    ]);
    const events = await env.DB.prepare("SELECT event_id FROM email_events").all();
    expect(events.results).toEqual([{ event_id: "new" }]);
  });
});
