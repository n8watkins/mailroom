import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { AppConfig } from "../src/apps";
import { APPS } from "./apps";
import type { EmailEventHook, Env, MailEvent } from "../src/types";

// The apps every test runs with: vitest.config.ts points `mailroom:apps` at test/apps.ts.
export const TEST_APPS: Record<string, AppConfig> = APPS;

export interface FakeEmail {
  sent: Array<Record<string, unknown>>;
  failNext?: { code?: string; message: string };
  send(message: unknown): Promise<{ messageId: string }>;
}

export function fakeEmail(): FakeEmail {
  const fake: FakeEmail = {
    sent: [],
    async send(message) {
      if (fake.failNext) {
        const { code, message: text } = fake.failNext;
        fake.failNext = undefined;
        throw Object.assign(new Error(text), code ? { code } : {});
      }
      fake.sent.push(message as Record<string, unknown>);
      return { messageId: `msg-${fake.sent.length}` };
    },
  };
  return fake;
}

export function fakeHook(): EmailEventHook & { calls: MailEvent[]; failNext: boolean } {
  const hook = {
    calls: [] as MailEvent[],
    failNext: false,
    async onEmailEvent(event: MailEvent) {
      if (hook.failNext) {
        hook.failNext = false;
        throw new Error("hook down");
      }
      hook.calls.push(event);
    },
  };
  return hook;
}

export async function resetDb(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(["sends", "email_events", "suppressions", "counters", "app_settings", "audit_log"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export function testEnv(overrides: Partial<Env> & Record<string, unknown> = {}): Env {
  return {
    DB: env.DB,
    EMAIL: fakeEmail() as unknown as SendEmail,
    GLOBAL_DAY_CAP: "900",
    PRIORITY_RESERVE: "150",
    ...overrides,
  } as Env;
}
