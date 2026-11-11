import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { usageReport } from "../src/index";
import { classifyBindingError, monthCaps, sendFor } from "../src/send";
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

  it("gives each app its own per-recipient allowance", async () => {
    const { send } = setup();
    // Another app mailing the same person first must not use up alpha's allowance of 2.
    for (let i = 0; i < 3; i++) expect(await send("beta", { ...base, kind: "notice" })).toMatchObject({ ok: true });
    expect(await send("alpha", base)).toMatchObject({ ok: true });
    expect(await send("alpha", base)).toMatchObject({ ok: true });
    expect(await send("alpha", base)).toMatchObject({ ok: false, code: "cap_recipient" });
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
    expect(counters.results.find((c) => c.key === "recipient:alpha:2026-11-11:six@example.net")?.n ?? 0).toBe(0);
  });

  it("keeps a reserve of the global cap for priority kinds", async () => {
    const { send } = setup({ GLOBAL_DAY_CAP: "3", PRIORITY_RESERVE: "1" });
    expect(await send("beta", { ...base, kind: "notice", to: "a@example.net" })).toMatchObject({ ok: true });
    expect(await send("beta", { ...base, kind: "notice", to: "b@example.net" })).toMatchObject({ ok: true });
    expect(await send("beta", { ...base, kind: "notice", to: "c@example.net" })).toMatchObject({ ok: false, code: "cap_global_day" });
    expect(await send("alpha", { ...base, kind: "signin", to: "c@example.net" })).toMatchObject({ ok: true });
    expect(await send("alpha", { ...base, kind: "signin", to: "d@example.net" })).toMatchObject({ ok: false, code: "cap_global_day" });
  });

  describe("the all-app monthly cap", () => {
    const notice = (to: string) => ({ ...base, kind: "notice", to });
    const signin = (to: string) => ({ ...base, kind: "signin", to });

    it("refuses at the cap with cap_global_month and keeps a reserve for sign-in", async () => {
      const { email, send } = setup({ GLOBAL_MONTH_CAP: "4", PRIORITY_MONTH_RESERVE: "1" });
      for (const n of [1, 2, 3]) expect(await send("beta", notice(`r${n}@example.net`))).toMatchObject({ ok: true });
      // 3 of 4 used: the last one is the sign-in reserve.
      expect(await send("beta", notice("r4@example.net"))).toEqual({
        ok: false,
        code: "cap_global_month",
        retryable: true,
        message: expect.stringContaining("month"),
      });
      expect(await send("alpha", signin("s1@example.net"))).toMatchObject({ ok: true });
      expect(await send("alpha", signin("s2@example.net"))).toMatchObject({ ok: false, code: "cap_global_month" });
      expect(email.sent).toHaveLength(4);
      // A refusal gives back what the earlier rules took.
      const app = await env.DB.prepare("SELECT n FROM counters WHERE key = 'app:beta:2026-11-10'").first<{ n: number }>();
      expect(app?.n).toBe(3);
      const row = await env.DB.prepare("SELECT status, error FROM sends WHERE recipient = 'r4@example.net'").first();
      expect(row).toEqual({ status: "failed", error: "cap_global_month" });
    });

    it("refuses everything with a cap of 0", async () => {
      const { email, send } = setup({ GLOBAL_MONTH_CAP: "0", PRIORITY_MONTH_RESERVE: "0" });
      expect(await send("alpha", signin("s@example.net"))).toMatchObject({ ok: false, code: "cap_global_month" });
      expect(email.sent).toHaveLength(0);
    });

    it("counts a rolling 32-day window across calendar months, not the calendar month", async () => {
      const { send } = setup({ GLOBAL_MONTH_CAP: "2", PRIORITY_MONTH_RESERVE: "0" });
      const day = (n: number) => NOW + n * 24 * 3600_000;
      expect(await send("beta", notice("a@example.net"), day(0))).toMatchObject({ ok: true }); // Nov 10
      expect(await send("beta", notice("b@example.net"), day(25))).toMatchObject({ ok: true }); // Dec 5
      // A new calendar month frees nothing: Nov 10 is still in the window on Dec 11.
      expect(await send("beta", notice("c@example.net"), day(31))).toMatchObject({ ok: false, code: "cap_global_month" });
      // On Dec 12, Nov 10 has left the 32-day window.
      expect(await send("beta", notice("c@example.net"), day(32))).toMatchObject({ ok: true });
      expect(await send("beta", notice("d@example.net"), day(32))).toMatchObject({ ok: false, code: "cap_global_month" });
    });

    it("holds under concurrent sends", async () => {
      const { email, send } = setup({ GLOBAL_MONTH_CAP: "5", PRIORITY_MONTH_RESERVE: "0" });
      const results = await Promise.all(Array.from({ length: 20 }, (_, n) => send("beta", notice(`c${n}@example.net`))));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.filter((r) => !r.ok && r.code === "cap_global_month")).toHaveLength(15);
      expect(email.sent).toHaveLength(5);
      const total = await env.DB.prepare("SELECT SUM(n) AS n FROM counters WHERE key LIKE 'globalm:%'").first<{ n: number }>();
      expect(total?.n).toBe(5);
    });

    it("falls back to 2,500 with 300 for sign-in when unset, never to unlimited", () => {
      expect(monthCaps(testEnv({ GLOBAL_MONTH_CAP: undefined, PRIORITY_MONTH_RESERVE: undefined }))).toEqual({ cap: 2500, priorityReserve: 300, warnAt: 1750 });
      expect(monthCaps(testEnv({ GLOBAL_MONTH_CAP: "lots", PRIORITY_MONTH_RESERVE: "-1" }))).toEqual({ cap: 2500, priorityReserve: 300, warnAt: 1750 });
      expect(monthCaps(testEnv({ GLOBAL_MONTH_CAP: "100", PRIORITY_MONTH_RESERVE: "500" }))).toEqual({ cap: 100, priorityReserve: 100, warnAt: 70 });
    });

    it("flags the admin at 70% of the cap, and emails nobody without ALERT_TO", async () => {
      const e = { GLOBAL_MONTH_CAP: "10", PRIORITY_MONTH_RESERVE: "0" };
      const { email, send } = setup(e);
      for (let n = 0; n < 6; n++) await send("beta", notice(`f${n}@example.net`));
      let usage = await usageReport(testEnv(e), NOW);
      expect(usage.globalMonth).toMatchObject({ used: 6, cap: 10, warnAt: 7, attention: false, attentionSince: null, windowStart: "2026-10-10", windowDays: 32 });
      await send("beta", notice("f6@example.net"), NOW + 1000);
      await send("beta", notice("f7@example.net"), NOW + 2000);
      usage = await usageReport(testEnv(e), NOW + 3000);
      expect(usage.globalMonth).toMatchObject({ used: 8, attention: true, attentionSince: NOW + 1000, alerts: [{ threshold: 70, at: NOW + 1000 }] });
      expect(email.sent).toHaveLength(8);
    });
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
