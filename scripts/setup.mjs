#!/usr/bin/env node
/**
 * `cortex init` — writes the Cortex agent + /cortex command family into the
 * target project's `.opencode/` directory (same pattern real-world plugins
 * use). Idempotent: never overwrites user-modified files without --force.
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, "..", "assets");
const target = resolve(process.argv[3] ?? process.cwd());
const force = process.argv.includes("--force");

function install(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    const src = join(srcDir, f);
    const dest = join(destDir, f);
    if (existsSync(dest) && !force) {
      console.log(`keep  ${dest} (exists; use --force to overwrite)`);
      continue;
    }
    copyFileSync(src, dest);
    console.log(`write ${dest}`);
  }
}

install(join(assets, "agent"), join(target, ".opencode", "agent"));
install(join(assets, "commands"), join(target, ".opencode", "commands"));
console.log("\nCortex installed. Add to opencode.jsonc: { \"plugin\": [\"cortex-opencode\"] }");
console.log("Then run: /cortex <objective>");
