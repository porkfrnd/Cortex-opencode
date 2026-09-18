#!/usr/bin/env node
// Development bin shim: runs the TS CLI via a build, or errors helpfully.
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist", "cli.js");
if (!existsSync(dist)) {
  console.error("cortex: dist/cli.js missing — run `npm run build` first.");
  process.exit(1);
}
const r = spawnSync(process.execPath, [dist, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
