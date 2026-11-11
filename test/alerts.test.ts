import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, recentSends, sendTestAlert } from "../src/admin";
import { ALERT_DAY_LIMIT, checkCapAlerts } from "../src/alerts";
import { usageReport } from "../src/index";
import { sendFor } from "../src/send";
import { fakeEmail, resetDb, testEnv, TEST_APPS } from "./helpers";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const OWNER = "owner@example.org";
const ALERTS = { ALERT_TO: OWNER, ALERT_FROM: "alerts@example.test", ADMIN_URL: "https://admin.example.test/mailroom" };
const notice = (to: string) => ({ kind: "notice", to, subject: "Hi", text: "Hello" });
const signin = (to: string) => ({ kind: "signin", to, subject: "Sign in", text: "Link" });

function setup(overrides: Record<string, unknown> = {}) {
  const email = fakeEmail();
  const e = testEnv({ EMAIL: email as unknown as SendEmail, ...ALERTS, ...overrides });
  const send = (app: string, req: Record<string, unknown>, now = NOW) => sendFor(app, req as never, { env: e, apps: TEST_APPS, now: () => now });
  const alerts = () => email.sent.filter((m) => m.to === OWNER);
  return { e, email, send, alerts };
}

describe("cap alerts", () => {
  beforeEach(resetDb);

  it("emails the owner once at 70, 85, 95 and 100% of the monthly cap", async () => {
    const { send, alerts } = setup({ GLOBAL_MONTH_CAP: "20", PRIORITY_MONTH_RESERVE: "0" });
    let sent = 0;
    const subjects = async (upTo: number) => {
      for (; sent < upTo; sent++) await send("beta", notice(`r${sent}@example.net`));
      return alerts().map((m) => m.subject);
    };
    expect(await subjects(13)).toEqual([]); // 65%
    expect(await subjects(14)).toEqual(["mailroom: monthly email cap at 70% (14 of 20)"]);
    expect(await subjects(17)).toHaveLength(2);
    expect(await subjects(19)).toHaveLength(3);
    expect(await subjects(20)).toEqual([
      "mailroom: monthly email cap at 70% (14 of 20)",
      "mailroom: monthly email cap at 85% (17 of 20)",
      "mailroom: monthly email cap at 95% (19 of 20)",
      "mailroom: monthly email cap reached (20 of 20)",
    ]);
    // More sends, all refused at the cap: no more alerts.
    for (let n = 20; n < 30; n++) expect(await send("beta", notice(`r${n}@example.net`))).toMatchObject({ code: "cap_global_month" });
    expect(alerts()).toHaveLength(4);
    const [first] = alerts();
    expect(first).toMatchObject({ from: { email: "alerts@example.test", name: "mailroom" } });
    expect(first!.text).toContain("14 of 20 sends in the last 32 days (since 2026-10-10)");
    expect(first!.text).toContain("Top apps, the last 32 days:\n  beta: 14");
    expect(first!.text).toContain("Mailroom admin: https://admin.example.test/mailroom");
  });

  it("sends the cap alert although the cap it reports on is full", async () => {
    const { send, alerts, email } = setup({ GLOBAL_MONTH_CAP: "2", PRIORITY_MONTH_RESERVE: "1" });
    expect(await send("beta", notice("a@example.net"))).toMatchObject({ ok: true });
    // The non-sign-in share is used up: the refusal is the cap being reached.
    expect(await send("beta", notice("b@example.net"))).toMatchObject({ ok: false, code: "cap_global_month" });
    expect(alerts().map((m) => m.subject)).toEqual(["mailroom: monthly email cap reached (1 of 2)"]);
    expect(alerts()[0]!.text).toContain("the last 1 are kept for sign-in links");
    expect(await send("alpha", signin("c@example.net"))).toMatchObject({ ok: true });
    expect(await send("alpha", signin("d@example.net"))).toMatchObject({ ok: false, code: "cap_global_month" });
    expect(alerts()).toHaveLength(1);
    // Alerts are not counted against the global caps.
    const total = await env.DB.prepare("SELECT SUM(n) AS n FROM counters WHERE key LIKE 'globalm:%'").first<{ n: number }>();
    expect(total?.n).toBe(2);
    expect(email.sent).toHaveLength(3);
  });

  it("emails once when the daily cap is reached, again the next day", async () => {
    const { send, alerts } = setup({ GLOBAL_DAY_CAP: "3", PRIORITY_RESERVE: "1" });
    await send("beta", notice("a@example.net"));
    await send("beta", notice("b@example.net"));
    expect(alerts()).toHaveLength(0);
    expect(await send("beta", notice("c@example.net"))).toMatchObject({ code: "cap_global_day" });
    expect(await send("beta", notice("d@example.net"))).toMatchObject({ code: "cap_global_day" });
    expect(await send("alpha", signin("e@example.net"))).toMatchObject({ ok: true }); // 3 of 3
    expect(alerts().map((m) => m.subject)).toEqual(["mailroom: daily email cap reached (2 of 3)"]);
    expect((await usageReport(setup().e, NOW)).globalDayCappedAt).toBe(NOW);
    const tomorrow = NOW + 24 * 3600_000;
    await send("beta", notice("a@example.net"), tomorrow);
    await send("beta", notice("b@example.net"), tomorrow);
    await send("beta", notice("c@example.net"), tomorrow);
    expect(alerts()).toHaveLength(2);
  });

  it("can't loop: alerts have their own daily limit and never trigger checks", async () => {
    const { e, alerts } = setup({ GLOBAL_MONTH_CAP: "10", PRIORITY_MONTH_RESERVE: "0" });
    await env.DB.prepare("INSERT INTO counters (key, n, expires_at) VALUES ('globalm:2026-11-10', 10, ?)").bind(NOW + 40 * 24 * 3600_000).run();
    // Every call finds the thresholds already claimed after the first.
    for (let i = 0; i < 50; i++) await checkCapAlerts(e, NOW + i, "cap_global_month");
    expect(alerts()).toHaveLength(1);
    // Even with the records cleared over and over, at most ALERT_DAY_LIMIT go out a day.
    for (let i = 0; i < 50; i++) {
      await env.DB.prepare("DELETE FROM counters WHERE key LIKE 'alert:%'").run();
      await checkCapAlerts(e, NOW + i, "cap_global_month");
    }
    expect(alerts()).toHaveLength(ALERT_DAY_LIMIT);
  });

  it("retries an alert the binding refused on the next send, and keeps the threshold when the alert limit is used up", async () => {
    const { e, alerts, email } = setup({ GLOBAL_MONTH_CAP: "10", PRIORITY_MONTH_RESERVE: "0" });
    await env.DB.prepare("INSERT INTO counters (key, n, expires_at) VALUES ('globalm:2026-11-10', 7, ?)").bind(NOW + 40 * 24 * 3600_000).run();
    email.failNext = { code: "E_INTERNAL_SERVER_ERROR", message: "down" };
    await checkCapAlerts(e, NOW);
    expect(alerts()).toHaveLength(0);
    expect((await usageReport(e, NOW)).globalMonth.alerts).toEqual([]);
    await checkCapAlerts(e, NOW + 1);
    expect(alerts().map((m) => m.subject)).toEqual(["mailroom: monthly email cap at 70% (7 of 10)"]);

    await env.DB.prepare("UPDATE counters SET n = 9 WHERE key = 'globalm:2026-11-10'").run();
    await env.DB.prepare("INSERT INTO counters (key, n, expires_at) VALUES ('alertsend:2026-11-10', ?, ?) ON CONFLICT (key) DO UPDATE SET n = excluded.n").bind(ALERT_DAY_LIMIT, NOW + 24 * 3600_000).run();
    await checkCapAlerts(e, NOW + 2);
    await checkCapAlerts(e, NOW + 3);
    expect(alerts()).toHaveLength(1);
    // Both thresholds crossed at once are recorded together.
    expect((await usageReport(e, NOW + 4)).globalMonth.alerts.map((a) => a.threshold)).toEqual([70, 85]);
  });

  it("sends a test alert to the owner only, with an audit entry, and claims no threshold", async () => {
    const { e, email, send, alerts } = setup({ GLOBAL_MONTH_CAP: "10", PRIORITY_MONTH_RESERVE: "0" });
    expect(await send("beta", notice("a@example.net"))).toMatchObject({ ok: true });
    expect(await sendTestAlert(e, " ", NOW)).toEqual({ ok: false, error: "An actor is required." });
    expect(await sendTestAlert(e, "owner", NOW)).toEqual({ ok: true, detail: "Sent a test alert to the alert address" });
    expect(alerts()).toHaveLength(1);
    expect(email.sent).toHaveLength(2);
    const [test] = alerts();
    expect(test).toMatchObject({ subject: "mailroom: test alert", from: { email: "alerts@example.test", name: "mailroom" } });
    expect(test!.text).toContain("sent by owner. Nothing is wrong");
    expect(test!.text).toContain("Top apps, the last 32 days:\n  beta: 1");
    expect((await auditLog(env.DB))[0]).toMatchObject({ actor: "owner", action: "alert.test", app: null, detail: "Sent a test alert to the alert address" });
    expect((await recentSends(env.DB))[0]).toMatchObject({ app: "mailroom", kind: "alert", status: "sent" });
    // No threshold is claimed and the global caps don't count it: the real 70% alert still fires.
    expect((await usageReport(e, NOW)).globalMonth).toMatchObject({ used: 1, alerts: [] });
    for (let i = 1; i < 7; i++) await send("beta", notice(`r${i}@example.net`));
    expect(alerts().map((m) => m.subject)).toEqual(["mailroom: test alert", "mailroom: monthly email cap at 70% (7 of 10)"]);
  });

  it("refuses a test alert without ALERT_TO, and past the alert limit", async () => {
    expect(await sendTestAlert(setup({ ALERT_TO: undefined }).e, "owner", NOW)).toEqual({ ok: false, error: "ALERT_TO and ALERT_FROM must both be set." });
    const { e, alerts } = setup();
    for (let i = 0; i < ALERT_DAY_LIMIT; i++) expect(await sendTestAlert(e, "owner", NOW + i)).toMatchObject({ ok: true });
    expect(await sendTestAlert(e, "owner", NOW + ALERT_DAY_LIMIT)).toEqual({ ok: false, error: "Test alert not sent: the alert send limit is used up" });
    expect(alerts()).toHaveLength(ALERT_DAY_LIMIT);
    expect((await auditLog(env.DB))[0]).toMatchObject({ action: "alert.test", detail: "Test alert not sent: the alert send limit is used up" });
  });

  it("records thresholds but emails nobody without ALERT_TO", async () => {
    const { e, email } = setup({ ALERT_TO: undefined, GLOBAL_MONTH_CAP: "10", PRIORITY_MONTH_RESERVE: "0" });
    await env.DB.prepare("INSERT INTO counters (key, n, expires_at) VALUES ('globalm:2026-11-10', 10, ?)").bind(NOW + 40 * 24 * 3600_000).run();
    await checkCapAlerts(e, NOW);
    expect(email.sent).toHaveLength(0);
    expect((await usageReport(e, NOW)).globalMonth).toMatchObject({ attention: true, attentionSince: NOW, alerts: [70, 85, 95, 100].map((threshold) => ({ threshold, at: NOW })) });
  });
});
