import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CORTEX_DIR = ".cortex";

export function cortexRoot(projectRoot: string): string {
  return join(resolve(projectRoot), CORTEX_DIR);
}

export function statePath(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "state", "state.json");
}

export function transitionsPath(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "state", "transitions.jsonl");
}

export function goalsPath(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "state", "goals.json");
}

export function busDir(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "bus");
}

export function memoryDir(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "memory");
}

export function evidenceDir(projectRoot: string): string {
  return join(cortexRoot(projectRoot), "evidence");
}

/**
 * Stable project identity that survives directory renames: prefers the git
 * remote URL, then the git root object hash material, then the resolved path.
 * Never uses the bare directory name alone.
 */
export function projectIdentity(projectRoot: string): string {
  const root = resolve(projectRoot);
  let seed = `path:${root}`;
  try {
    const gitConfig = join(root, ".git", "config");
    if (existsSync(gitConfig)) {
      const cfg = readFileSync(gitConfig, "utf8");
      const m = cfg.match(/url\s*=\s*(.+)/);
      if (m) seed = `remote:${m[1].trim()}`;
      else seed = `gitdir:${root}`;
    }
  } catch {
    // fall through to path seed
  }
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
