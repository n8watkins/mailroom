import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyBindingError, sendFor } from "../src/send";
import { fakeEmail, resetDb, testEnv, TEST_APPS } from "./helpers";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const base = { kind: "digest", to: "Reader@Example.net", subject: "Weekly", text: "Hello" };

function setup(overrides: Record<string, unknown> = {}) {
  const email = fakeEmail();
  const e = testEnv({ EMAIL: email as unknown as SendEmail, ...overrides });
  const send = (app: string | undefined, req: Record<string, unknown>, now = NOW) =>
    sendFor(app, req as never, { env: e, apps: TEST_APPS, now: () => now });
  return { email, send };
}

describe("send", () => {
  beforeEach(resetDb);

  it("sends from the app's default sender and records the message id", async () => {
    const { email, send } = setup();
    const result = await send("alpha", { ...base, html: "<p>Hello</p>", fromName: "Alpha" });
    expect(result).toEqual({ ok: true, messageId: "msg-1" });
    expect(email.sent[0]).toMatchObject({
      to: "Reader@Example.net",
      from: { email: "alpha@example.test", name: "Alpha" },
      subject: "Weekly",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    const row = await env.DB.prepare("SELECT app, kind, recipient, status, message_id FROM sends").first();
    expect(row).toEqual({ app: "alpha", kind: "digest", recipient: "reader@example.net", status: "sent", message_id: "msg-1" });
  });

  it("refuses unknown apps, kinds and senders without sending", async () => {
    const { email, send } = setup();
    expect(await send(undefined, base)).toMatchObject({ ok: false, code: "unknown_app" });
    expect(await send("nope", base)).toMatchObject({ ok: false, code: "unknown_app" });
    expect(await send("alpha", { ...base, kind: "newsletter" })).toMatchObject({ ok: false, code: "kind_not_allowed" });
    expect(await send("alpha", { ...base, from: "beta@example.test" })).toMatchObject({ ok: false, code: "sender_not_allowed" });
    expect(await send("alpha", { ...base, to: "a@b.c, d@e.f" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send("alpha", { ...base, subject: "a\r\nBcc: x@y.z" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await send("alpha", { ...base, text: "" })).toMatchObject({ ok: false, code: "invalid" });
    expect(email.sent).toHaveLength(0);
  });

  it("allows any address on a domain rule", async () => {
    const { email, send } = setup();
    expect(await send("alpha", { ...base, from: "joes-plumbing@notify.example.test" })).toMatchObject({ ok: true });
    expect(await send("alpha", { ...base, from: "x@evil-notify.example.test" })).toMatchObject({ code: "sender_not_allowed" });
    expect(email.sent).toHaveLength(1);
  });

  it("sends a key once and reports the duplicate", async () => {
    const { email, send } = setup();
    expect(await send("alpha", { ...base, key: "job-1" })).toEqual({ ok: true, messageId: "msg-1" });
    expect(await send("alpha", { ...base, key: "job-1" })).toEqual({ ok: true, messageId: "msg-1", duplicate: true });
    // Keys are per app.
    expect(await send("beta", { ...base, kind: "notice", key: "job-1" })).toMatchObject({ ok: true, messageId: "msg-2" });
    expect(email.sent).toHaveLength(2);
  });

  it("retries a key whose first try failed, and holds a fresh pending one", async () => {
    const { email, send } = setup();
    email.failNext = { code: "E_INTERNAL_SERVER_ERROR", message: "boom" };
    expect(await send("alpha", { ...base, key: "job-2" })).toMatchObject({ ok: false, code: "unavailable", retryable: true });
    expect(await send("alpha", { ...base, key: "job-2" })).toMatchObject({ ok: true });

    await env.DB.prepare("INSERT INTO sends (app, kind, sender, recipient, idem_key, status, created_at, updated_at) VALUES ('alpha','digest','alpha@example.test','r@example.net','job-3','pending',?,?)")
      .bind(NOW, NOW)
      .run();
    expect(await send("alpha", { ...base, key: "job-3" }, NOW + 60_000)).toMatchObject({ ok: false, code: "in_progress" });
    // A pending send older than 15 minutes is taken as dead.
    expect(await send("alpha", { ...base, key: "job-3" }, NOW + 16 * 60_000)).toMatchObject({ ok: true });
  });

  it("enforces per-recipient, daily and monthly caps, and gives back units of failed sends", async () => {
    const { email, send } = setup();
    expect(await send("alpha", base)).toMatchObject({ ok: true });
    expect(await send("alpha", base)).toMatchObject({ ok: true });
    expect(await send("alpha", base)).toMatchObject({ ok: false, code: "cap_recipient", retryable: true });
    expect(await send("alpha", { ...base, to: "two@example.net" })).toMatchObject({ ok: true });
    expect(await send("alpha", { ...base, to: "three@example.net" })).toMatchObject({ ok: false, code: "cap_app_day" });

    // A failed send does not use up the allowance.
    const nextDay = NOW + 24 * 3600_000;
    email.failNext = { code: "E_INTERNAL_SERVER_ERROR", message: "boom" };
    expect(await send("alpha", { ...base, to: "four@example.net" }, nextDay)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await send("alpha", { ...base, to: "four@example.net" }, nextDay)).toMatchObject({ ok: true });
    expect(await send("alpha", { ...base, to: "five@example.net" }, nextDay)).toMatchObject({ ok: true });
    // Month cap of 5: 3 yesterday and 2 today.
    expect(await send("alpha", { ...base, to: "six@example.net" }, nextDay)).toMatchObject({ ok: false, code: "cap_app_month" });
    expect(email.sent).toHaveLength(5);

    // A refusal by a later rule gives back the units the earlier rules took.
    const counters = await env.DB.prepare("SELECT key, n FROM counters ORDER BY key").all<{ key: string; n: number }>();
    expect(counters.results.find((c) => c.key === "recipient:2026-11-11:six@example.net")?.n ?? 0).toBe(0);
  });

  it("keeps a reserve of the global cap for priority kinds", async () => {
    const { send } = setup({ GLOBAL_DAY_CAP: "3", PRIORITY_RESERVE: "1" });
    expect(await send("beta", { ...base, kind: "notice", to: "a@example.net" })).toMatchObject({ ok: true });
    expect(await send("beta", { ...base, kind: "notice", to: "b@example.net" })).toMatchObject({ ok: true });
    expect(await send("beta", { ...base, kind: "notice", to: "c@example.net" })).toMatchObject({ ok: false, code: "cap_global_day" });
    expect(await send("alpha", { ...base, kind: "signin", to: "c@example.net" })).toMatchObject({ ok: true });
    expect(await send("alpha", { ...base, kind: "signin", to: "d@example.net" })).toMatchObject({ ok: false, code: "cap_global_day" });
  });

  it("refuses suppressed addresses and learns Cloudflare's suppressions", async () => {
    const { email, send } = setup();
    email.failNext = { code: "E_RECIPIENT_SUPPRESSED", message: "suppressed" };
    expect(await send("alpha", base)).toMatchObject({ ok: false, code: "suppressed", retryable: false });
    expect(await send("beta", { ...base, kind: "notice" })).toMatchObject({ ok: false, code: "suppressed" });
    expect(email.sent).toHaveLength(0);
  });

  it("classifies binding errors", () => {
    expect(classifyBindingError({ code: "E_RATE_LIMIT_EXCEEDED" })).toEqual({ code: "rate_limited", retryable: true });
    expect(classifyBindingError({ code: "E_DAILY_LIMIT_EXCEEDED" })).toEqual({ code: "daily_limit", retryable: true });
    expect(classifyBindingError({ code: "E_SENDER_NOT_VERIFIED" })).toEqual({ code: "rejected", retryable: false });
    expect(classifyBindingError(new TypeError("network"))).toEqual({ code: "unavailable", retryable: true });
  });
});
