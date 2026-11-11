#!/usr/bin/env node
// Deploys one mailroom deployment: applies its D1 migrations, then deploys the Worker.
//
//   node scripts/deploy.mjs [config]                 migrations + deploy (default: wrangler.jsonc)
//   node scripts/deploy.mjs --migrate-only [config]  migrations only
//   node scripts/deploy.mjs --dry-run [config...]    bundle without deploying (default: every deployment)
//
// npm scripts: `npm run deploy`, `npm run db:migrate`, `npm run check:deploy`;
// pass a config after `--`, for example `npm run deploy -- deployments/acme/wrangler.jsonc`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

// Wrangler's own CLI entry, run with this Node (no npx or shell, so it works the same on Windows).
const wranglerPackage = createRequire(import.meta.url).resolve("wrangler/package.json");
const wrangler = join(dirname(wranglerPackage), JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const migrateOnly = args.includes("--migrate-only");
const configs = args.filter((a) => !a.startsWith("--"));

function run(...wranglerArgs) {
  const result = spawnSync(process.execPath, [wrangler, ...wranglerArgs], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function allDeployments() {
  const found = ["wrangler.jsonc"];
  if (existsSync("deployments")) {
    for (const d of readdirSync("deployments", { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join("deployments", d.name, "wrangler.jsonc"))) found.push(join("deployments", d.name, "wrangler.jsonc"));
    }
  }
  return found;
}

if (dryRun) {
  for (const config of configs.length ? configs : allDeployments()) {
    const name = config === "wrangler.jsonc" ? "template" : basename(dirname(config));
    console.log(`\n▸ ${config}`);
    run("deploy", "--dry-run", "-c", config, "--outdir", join(".wrangler", "dry-run", name));
  }
} else {
  if (configs.length > 1) {
    console.error("Deploy one deployment at a time.");
    process.exit(1);
  }
  const config = configs[0] ?? "wrangler.jsonc";
  const placeholder = readFileSync(config, "utf8").match(/<your [^>]+>/);
  if (placeholder) {
    console.error(`${config} still has the placeholder ${placeholder[0]}. Fill it in first (README.md, "Quick start").`);
    process.exit(1);
  }
  run("d1", "migrations", "apply", "DB", "--remote", "-c", config);
  if (!migrateOnly) run("deploy", "-c", config);
}
