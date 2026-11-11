/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkApps, type Apps } from "../src/apps";

// Every deployment's apps file, by its path from the repository root.
const modules = import.meta.glob<{ APPS: Apps }>(["../apps.config.ts", "../deployments/*/apps.ts"], { eager: true });
const appsAt = (path: string) => modules[`../${path}`]?.APPS;

describe("deployments", () => {
  it("finds the template and every deployment", () => {
    expect(env.TEST_DEPLOYMENTS.map((d) => d.config)).toContain("wrangler.jsonc");
  });

  for (const deployment of env.TEST_DEPLOYMENTS) {
    it(`${deployment.config} has valid apps that match its bindings`, () => {
      expect(deployment.apps, `${deployment.config} needs "alias": { "mailroom:apps": "<its apps file>" }`).toBeTruthy();
      const apps = appsAt(deployment.apps!);
      expect(apps, `${deployment.apps} must be apps.config.ts or deployments/<name>/apps.ts and export APPS`).toBeTruthy();
      expect(checkApps(apps!, { allowedSenders: deployment.allowedSenders ?? undefined, services: deployment.services, globalDayCap: deployment.globalDayCap, globalMonthCap: deployment.globalMonthCap })).toEqual([]);
    });

    it(`${deployment.config} sets caps the account can't overspend`, () => {
      // Under the plan's 3,000 included emails a month, and the apps' monthly caps within the all-app cap.
      expect(Number.isInteger(deployment.globalDayCap) && deployment.globalDayCap > 0).toBe(true);
      expect(deployment.globalMonthCap).toBeGreaterThan(0);
      expect(deployment.globalMonthCap).toBeLessThan(3000);
      const apps = appsAt(deployment.apps!)!;
      const monthly = Object.values(apps).reduce((sum, app) => sum + app.caps.month, 0);
      expect(monthly, "the apps' monthly caps add up to more than GLOBAL_MONTH_CAP").toBeLessThanOrEqual(deployment.globalMonthCap);
    });
  }
});

describe("checkApps", () => {
  const ok: Apps = { a: { senders: ["a@x.test"], kinds: ["signin"], priority: ["signin"], caps: { day: 2, month: 3, recipientDay: 1 }, hook: "HOOK_A" } };

  it("accepts a valid app", () => {
    expect(checkApps(ok, { allowedSenders: ["A@x.test"], services: ["HOOK_A"] })).toEqual([]);
  });

  it("names each problem", () => {
    const bad: Apps = {
      Bad: { senders: ["nope", "b@x.test"], kinds: [], priority: ["signin"], caps: { day: 5, month: 1, recipientDay: 1.5 }, hook: "HOOK_B" },
      c: { senders: ["b@x.test"], kinds: ["k"], caps: { day: 1, month: 1, recipientDay: 1 }, hook: "PRPOST" },
    };
    const problems = checkApps(bad, { allowedSenders: ["c@x.test"], services: [] });
    expect(problems).toEqual([
      "Bad: the id must be lowercase letters, digits and dashes.",
      'Bad: "nope" is not an address or an "@domain" rule.',
      'Bad: "nope" is missing from the send_email binding\'s allowed_sender_addresses.',
      'Bad: "b@x.test" is missing from the send_email binding\'s allowed_sender_addresses.',
      "Bad: `kinds` must list at least one kind.",
      'Bad: priority kind "signin" is not one of its kinds.',
      "Bad: caps.recipientDay must be a whole number, 0 or more.",
      "Bad: caps must keep recipientDay <= day <= month.",
      'Bad: hook "HOOK_B" is not a service binding in the wrangler config.',
      'c: "b@x.test" is missing from the send_email binding\'s allowed_sender_addresses.',
      'c: "b@x.test" is also a sender of Bad; each sender belongs to one app.',
      'c: hook "PRPOST" must be a binding name starting with HOOK_.',
    ]);
  });

  it("refuses daily or monthly caps that add up to more than the all-app caps", () => {
    const two: Apps = { ...ok, b: { ...ok.a!, senders: ["b@x.test"], caps: { day: 2, month: 3, recipientDay: 1 } } };
    const bindings = { services: ["HOOK_A"] };
    expect(checkApps(two, { ...bindings, globalDayCap: 4, globalMonthCap: 6 })).toEqual([]);
    expect(checkApps(two, { ...bindings, globalDayCap: 3, globalMonthCap: 5 })).toEqual([
      "The apps' daily caps add up to 4, over GLOBAL_DAY_CAP (3).",
      "The apps' monthly caps add up to 6, over GLOBAL_MONTH_CAP (5).",
    ]);
  });
});
