import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, maskAddress, maskText, problemEvents, recentSends, removeSuppression, setDailyCap, setPaused, suppressionList } from "../src/admin";
import { usageReport } from "../src/index";
import { isSuppressed, sendFor, suppress } from "../src/send";
import { fakeEmail, resetDb, testEnv } from "./helpers";

const NOW = Date.UTC(2026, 10, 10, 12);

async function resetAdmin() {
  await resetDb();
  await env.DB.batch([env.DB.prepare("DELETE FROM app_settings"), env.DB.prepare("DELETE FROM audit_log")]);
}

describe("admin", () => {
  beforeEach(resetAdmin);

  it("masks addresses, inside SMTP replies too", () => {
    expect(maskAddress("jonathan@Gmail.com")).toBe("jo***@gmail.com");
    expect(maskAddress("al@x.io")).toBe("a***@x.io");
    expect(maskAddress("nope")).toBe("***");
    expect(maskText("550 5.1.1 <jonathan@gmail.com>: user unknown")).toBe("550 5.1.1 <jo***@gmail.com>: user unknown");
  });

  it("lists recent sends, problems and suppressions without full addresses", async () => {
    const e = testEnv({ EMAIL: fakeEmail() as unknown as SendEmail });
    await sendFor("wren", { kind: "signin", to: "reader@example.net", subject: "Sign in", text: "Link" }, { env: e, now: () => NOW });
    await env.DB.prepare(
      "INSERT INTO email_events (event_id, app, type, recipient, bounce_type, reason, received_at) VALUES ('e1', 'wren', 'bounced', 'gone@example.net', 'hard', '550 5.1.1 gone@example.net unknown', ?)",
    )
      .bind(NOW)
      .run();
    await suppress(env.DB, { recipient: "gone@example.net", reason: "hard_bounce", app: "wren", eventId: "e1", now: NOW });

    const everything = JSON.stringify([await recentSends(env.DB), await problemEvents(env.DB), await suppressionList(env.DB)]);
    expect(everything).not.toContain("reader@");
    expect(everything).not.toContain("gone@");
    expect(everything).not.toContain("Link");
    expect((await recentSends(env.DB))[0]).toMatchObject({ app: "wren", kind: "signin", recipient: "re***@example.net", status: "sent" });
    expect((await problemEvents(env.DB))[0]).toMatchObject({ type: "bounced", recipient: "go***@example.net", reason: "550 5.1.1 go***@example.net unknown" });
  });

  it("removes a suppression by id, with an audit entry", async () => {
    await suppress(env.DB, { recipient: "gone@example.net", reason: "hard_bounce", app: "wren", eventId: null, now: NOW });
    const [row] = await suppressionList(env.DB);
    expect(await removeSuppression(env.DB, row!.id, "", NOW)).toEqual({ ok: false, error: "An actor is required." });
    expect(await removeSuppression(env.DB, row!.id, "n8watkins", NOW)).toMatchObject({ ok: true });
    expect(await isSuppressed(env.DB, "gone@example.net")).toBe(false);
    expect(await removeSuppression(env.DB, row!.id, "n8watkins", NOW)).toMatchObject({ ok: false });
    const [entry] = await auditLog(env.DB);
    expect(entry).toMatchObject({ actor: "n8watkins", action: "suppression.remove", app: "wren", detail: "Removed go***@example.net (hard_bounce) from the suppression list" });
  });

  it("pauses and resumes an app, which refuses sends while paused", async () => {
    const e = testEnv({ EMAIL: fakeEmail() as unknown as SendEmail });
    const send = () => sendFor("wren", { kind: "signin", to: "a@example.net", subject: "s", text: "t" }, { env: e, now: () => NOW });
    expect(await setPaused(env.DB, "nope", true, "n8watkins", NOW)).toMatchObject({ ok: false, error: "Unknown app." });
    expect(await setPaused(env.DB, "wren", true, "n8watkins", NOW)).toMatchObject({ ok: true });
    expect(await send()).toMatchObject({ ok: false, code: "paused", retryable: true });
    expect((await usageReport(e, NOW)).apps.find((a) => a.app === "wren")?.paused).toBe(true);
    expect(await setPaused(env.DB, "wren", false, "n8watkins", NOW + 1)).toMatchObject({ ok: true });
    expect(await send()).toMatchObject({ ok: true });
    expect((await auditLog(env.DB)).map((a) => a.action)).toEqual(["app.resume", "app.pause"]);
  });

  it("sets and clears an app's daily cap within the all-app cap", async () => {
    const e = testEnv({ EMAIL: fakeEmail() as unknown as SendEmail });
    expect(await setDailyCap(env.DB, e, "wren", 901, "n8watkins", NOW)).toMatchObject({ ok: false });
    expect(await setDailyCap(env.DB, e, "wren", 1.5, "n8watkins", NOW)).toMatchObject({ ok: false });
    expect(await setDailyCap(env.DB, e, "wren", 1, "n8watkins", NOW)).toEqual({ ok: true, detail: "Daily cap for wren set to 1 (was 60)" });
    const send = (to: string) => sendFor("wren", { kind: "signin", to, subject: "s", text: "t" }, { env: e, now: () => NOW });
    expect(await send("a@example.net")).toMatchObject({ ok: true });
    expect(await send("b@example.net")).toMatchObject({ ok: false, code: "cap_app_day" });
    const wren = (await usageReport(e, NOW)).apps.find((a) => a.app === "wren");
    expect(wren?.caps.day).toBe(1);
    expect(wren?.defaultDayCap).toBe(60);
    expect(await setDailyCap(env.DB, e, "wren", null, "n8watkins", NOW)).toEqual({ ok: true, detail: "Daily cap for wren back to its default of 60 (was 1)" });
    expect(await send("b@example.net")).toMatchObject({ ok: true });
  });
});
