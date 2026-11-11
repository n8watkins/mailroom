/** The apps the tests run with (vitest.config.ts points `mailroom:apps` here). */
import type { Apps } from "../src/apps";

export const APPS = {
  alpha: {
    senders: ["alpha@example.test", "@notify.example.test"],
    kinds: ["signin", "digest"],
    priority: ["signin"],
    caps: { day: 3, month: 5, recipientDay: 2 },
    hook: "HOOK_ALPHA",
  },
  beta: {
    senders: ["beta@example.test"],
    kinds: ["notice"],
    caps: { day: 100, month: 100, recipientDay: 100 },
  },
} satisfies Apps;
