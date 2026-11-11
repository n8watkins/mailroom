import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { unstable_readConfig } from "wrangler";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Every deployment in the repository (the root wrangler.jsonc and each
 * deployments/<name>/wrangler.jsonc), with what test/config.test.ts checks
 * its apps against.
 */
function deployments() {
  const configs = [
    "wrangler.jsonc",
    ...(existsSync(resolve(root, "deployments")) ? readdirSync(resolve(root, "deployments"), { withFileTypes: true }) : [])
      .filter((d) => d.isDirectory() && existsSync(resolve(root, "deployments", d.name, "wrangler.jsonc")))
      .map((d) => `deployments/${d.name}/wrangler.jsonc`),
  ];
  return configs.map((config) => {
    const c = unstable_readConfig({ config: resolve(root, config) });
    const apps = c.alias?.["mailroom:apps"];
    return {
      config,
      apps: apps ? relative(root, resolve(root, dirname(config), apps)).replaceAll("\\", "/") : null,
      allowedSenders: c.send_email.find((b) => b.name === "EMAIL")?.allowed_sender_addresses ?? null,
      services: c.services?.map((s) => s.binding) ?? [],
      globalDayCap: Number(c.vars?.GLOBAL_DAY_CAP),
      // The default when unset (src/send.ts DEFAULT_GLOBAL_MONTH_CAP).
      globalMonthCap: c.vars?.GLOBAL_MONTH_CAP === undefined ? 2500 : Number(c.vars.GLOBAL_MONTH_CAP),
    };
  });
}

// Tests run in workerd with a local D1. The send_email binding is replaced by
// an in-memory fake per test (test/helpers.ts), so no test ever sends email.
export default defineConfig({
  resolve: {
    // The tests' own apps, not any deployment's (each deployment's are checked by test/config.test.ts).
    alias: { "mailroom:apps": resolve(root, "test/apps.ts") },
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        d1Databases: ["DB"],
        bindings: {
          GLOBAL_DAY_CAP: "900",
          PRIORITY_RESERVE: "150",
          GLOBAL_MONTH_CAP: "2500",
          PRIORITY_MONTH_RESERVE: "300",
          TEST_MIGRATIONS: await readD1Migrations(resolve(root, "migrations")),
          TEST_DEPLOYMENTS: deployments(),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
