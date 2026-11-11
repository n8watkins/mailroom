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

  it("reports usage per app without addresses", async () => {
    const usage = await usageReport(testEnv());
    expect(usage.apps.map((a) => a.app)).toEqual(Object.keys(APPS));
    expect(usage.globalDayCap).toBe(900);
    expect(JSON.stringify(usage)).not.toContain("@");
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
