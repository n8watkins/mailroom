import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run in workerd with a local D1. The send_email binding is replaced by
// an in-memory fake per test (test/helpers.ts), so no test ever sends email.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        d1Databases: ["DB"],
        bindings: {
          GLOBAL_DAY_CAP: "900",
          PRIORITY_RESERVE: "150",
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
