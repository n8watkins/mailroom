import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { cleanup, usageReport } from "../src/index";
import { APPS, appForSender } from "../src/apps";
import { resetDb, testEnv } from "./helpers";

describe("worker", () => {
  beforeEach(resetDb);

  it("has no public HTTP interface", async () => {
    const response = await worker.fetch();
    expect(response.status).toBe(404);
  });

  it("acks handled queue messages and retries failed ones", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const message = (id: string, body: unknown) => ({
      id,
      body,
      attempts: 1,
      timestamp: new Date(),
      ack: () => acked.push(id),
      retry: () => retried.push(id),
    });
    const brokenDb = {
      prepare() {
        throw new Error("db down");
      },
    } as unknown as D1Database;
    const batch = {
      queue: "mailroom-email-events",
      messages: [message("1", { type: "cf.email.sending.message.delivered", payload: { eventId: "e1", sender: "prpost@n8builds.dev" } })],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch;
    await worker.queue(batch as never, testEnv());
    await worker.queue(
      { ...batch, messages: [message("2", { type: "cf.email.sending.message.delivered", payload: { eventId: "e2" } })] } as never,
      testEnv({ DB: brokenDb }),
    );
    expect(acked).toEqual(["1"]);
    expect(retried).toEqual(["2"]);
  });

  it("reports usage per app without recipient addresses", async () => {
    const usage = await usageReport(testEnv());
    expect(usage.apps.map((a) => a.app)).toEqual(Object.keys(APPS));
    expect(usage.globalDayCap).toBe(900);
    expect(usage.monthlyIncluded).toBe(3000);
    expect(usage.eventsSince).toBeNull();
    expect(JSON.stringify(usage)).not.toContain("@");
  });

  it("counts this month's delivered and bounced messages per app from events, once per message", async () => {
    const now = Date.UTC(2026, 10, 10, 12);
    const lastMonth = Date.UTC(2026, 9, 31, 12);
    const rows: Array<[string, string | null, string, string, string, number]> = [
      ["e1", "prpost", "delivered", "m1", "prpost@n8builds.dev", now],
      ["e2", "prpost", "deferred", "m2", "prpost@n8builds.dev", now],
      ["e3", "prpost", "delivered", "m2", "prpost@n8builds.dev", now],
      ["e4", "prpost", "bounced", "m2", "prpost@n8builds.dev", now],
      ["e5", "wren", "bounced", "m3", "wren@n8builds.dev", now],
      ["e6", "wren", "delivered", "m4", "wren@n8builds.dev", lastMonth],
      ["e7", null, "delivered", "m5", "hello@techforpros.com", now],
      ["e8", "wren", "complained", "m6", "wren@n8builds.dev", now],
    ];
    await env.DB.batch(
      rows.map(([id, app, type, msg, sender, at]) =>
        env.DB.prepare("INSERT INTO email_events (event_id, app, type, message_id, sender, recipient, received_at) VALUES (?, ?, ?, ?, ?, 'x@example.net', ?)").bind(id, app, type, msg, sender, at),
      ),
    );
    const usage = await usageReport(testEnv(), now);
    const byApp = Object.fromEntries(usage.apps.map((a) => [a.app, a]));
    expect(byApp.prpost?.sentMonth).toBe(2);
    expect(byApp.wren).toMatchObject({ sentMonth: 1, bounces30d: 1, complaints30d: 1 });
    expect(usage.otherSenders).toEqual([{ sender: "hello@techforpros.com", sentMonth: 1 }]);
    expect(usage.accountMonth).toBe(4);
    expect(usage.monthStart).toBe("2026-11-01");
    expect(usage.eventsSince).toBe(lastMonth);
  });

  it("cleans up expired counters", async () => {
    await env.DB.prepare("INSERT INTO counters (key, n, expires_at) VALUES ('old', 1, 1), ('new', 1, ?)").bind(Date.now() + 1000).run();
    await cleanup(testEnv());
    const { results } = await env.DB.prepare("SELECT key FROM counters").all<{ key: string }>();
    expect(results.map((r) => r.key)).toEqual(["new"]);
  });

  it("maps every configured sender back to its app", () => {
    for (const [id, app] of Object.entries(APPS)) {
      for (const sender of app.senders.filter((s) => !s.startsWith("@"))) expect(appForSender(sender)).toBe(id);
    }
  });
});
