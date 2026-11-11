import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { eventsFor, handleEvent, type EmailSendingEvent } from "../src/events";
import { isSuppressed, sendFor } from "../src/send";
import { fakeEmail, fakeHook, resetDb, testEnv, TEST_APPS } from "./helpers";

function event(type: string, payload: Record<string, unknown>): EmailSendingEvent {
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", domain: "example.test" },
    payload: { eventId: `ev-${type}-${String(payload.recipient)}`, sender: "alpha@example.test", recipient: "user@example.net", ...payload },
    metadata: { eventTimestamp: "2026-11-10T12:00:00.000Z" },
  } as EmailSendingEvent;
}

describe("events", () => {
  beforeEach(resetDb);

  it("suppresses a hard bounce, passes it to the app's hook, and stops later sends from every app", async () => {
    const hook = fakeHook();
    const email = fakeEmail();
    const e = testEnv({ EMAIL: email as unknown as SendEmail, HOOK_ALPHA: hook });
    const sent = await sendFor("alpha", { kind: "digest", to: "gone@example.net", subject: "Hi", text: "Hi" }, { env: e, apps: TEST_APPS });
    expect(sent).toMatchObject({ ok: true, messageId: "msg-1" });

    const bounce = event("bounced", {
      messageId: "msg-1",
      sender: "unknown@elsewhere.test",
      recipient: "Gone@Example.net",
      delivery: { status: "bounced", smtpStatusCode: "550", smtpEnhancedStatusCode: "5.1.1", smtpResponse: "550 5.1.1 User unknown" },
      bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" },
    });
    const handled = await handleEvent(bounce, { env: e, apps: TEST_APPS });
    // Matched to the app by message id, not by the sender.
    expect(handled).toMatchObject({ app: "alpha", type: "bounced", recipient: "gone@example.net", bounceType: "hard", smtpStatus: "5.1.1", suppressed: true });
    expect(hook.calls).toHaveLength(1);
    expect(await isSuppressed(env.DB, "gone@example.net")).toBe(true);

    const again = await sendFor("beta", { kind: "notice", to: "gone@example.net", subject: "Hi", text: "Hi" }, { env: e, apps: TEST_APPS });
    expect(again).toMatchObject({ ok: false, code: "suppressed" });

    // A redelivered event is stored once and not passed on twice.
    await handleEvent(bounce, { env: e, apps: TEST_APPS });
    expect(hook.calls).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_events").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("suppresses complaints but not soft bounces, and only stores deliveries", async () => {
    const hook = fakeHook();
    const e = testEnv({ HOOK_ALPHA: hook });
    await handleEvent(event("complained", { recipient: "angry@example.net" }), { env: e, apps: TEST_APPS });
    await handleEvent(event("bounced", { recipient: "full@example.net", bounce: { type: "soft" } }), { env: e, apps: TEST_APPS });
    await handleEvent(event("delivered", { recipient: "ok@example.net" }), { env: e, apps: TEST_APPS });
    expect(await isSuppressed(env.DB, "angry@example.net")).toBe(true);
    expect(await isSuppressed(env.DB, "full@example.net")).toBe(false);
    expect(hook.calls.map((c) => c.type)).toEqual(["complained", "bounced"]);

    const list = await eventsFor(env.DB, "alpha");
    expect(list.map((x) => [x.type, x.suppressed])).toEqual([
      ["complained", true],
      ["bounced", false],
      ["delivered", false],
    ]);
    expect(await eventsFor(env.DB, "alpha", { since: list[2]!.receivedAt })).toEqual([]);
  });

  it("throws when the hook fails so the queue retries, then delivers once", async () => {
    const hook = fakeHook();
    hook.failNext = true;
    const e = testEnv({ HOOK_ALPHA: hook });
    const bounce = event("bounced", { recipient: "x@example.net", bounce: { type: "hard" } });
    await expect(handleEvent(bounce, { env: e, apps: TEST_APPS })).rejects.toThrow("hook down");
    await handleEvent(bounce, { env: e, apps: TEST_APPS });
    expect(hook.calls).toHaveLength(1);
  });

  it("stores events for apps without a hook and ignores other sources", async () => {
    const e = testEnv();
    const ev = await handleEvent(event("failed", { sender: "beta@example.test", recipient: "y@example.net" }), { env: e, apps: TEST_APPS });
    expect(ev).toMatchObject({ app: "beta", type: "failed", suppressed: false });
    expect(await handleEvent({ type: "cf.r2.object.created" } as EmailSendingEvent, { env: e, apps: TEST_APPS })).toBeNull();
  });
});
