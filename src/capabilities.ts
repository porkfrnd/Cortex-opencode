import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Capability } from "./types.js";

export interface CapabilityInventory {
  at: string;
  capabilities: Capability[];
}

/** Two-pass discovery: pass 1 reads metadata only; pass 2 selects relevant. */
export function discoverCapabilities(projectRoot: string): CapabilityInventory {
  const root = resolve(projectRoot);
  const caps: Capability[] = [];

  // Built-in runtime capabilities (always present surface).
  for (const t of ["read", "write", "edit", "bash", "grep", "glob"]) {
    caps.push({ kind: "tool", name: t, description: `built-in ${t} tool`, source: "builtin" });
  }
  caps.push({ kind: "runtime", name: "filesystem", description: "file read/write/edit access", source: "builtin" });
  caps.push({ kind: "runtime", name: "shell", description: "shell command execution", source: "builtin" });

  // Skills: global + project.
  for (const dir of [join(process.env.HOME ?? "~", ".config", "opencode", "skills"), join(root, ".opencode", "skills")]) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(dir, entry.name, "SKILL.md");
        let desc = `skill ${entry.name}`;
        try {
          if (existsSync(skillFile)) {
            const head = readFileSync(skillFile, "utf8").slice(0, 500);
            const m = head.match(/description:\s*(.+)/i);
            desc = m ? m[1].trim() : head.split("\n").filter(Boolean)[0] ?? desc;
          }
        } catch { /* metadata best-effort */ }
        caps.push({ kind: "skill", name: entry.name, description: desc, source: dir });
      }
    } catch { /* ignore unreadable */ }
  }

  // Agents: global + project markdown/json definitions (metadata only).
  for (const dir of [
    join(process.env.HOME ?? "~", ".config", "opencode", "agent"),
    join(root, ".opencode", "agent"),
  ]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!/\.(md|json)$/.test(f)) continue;
        caps.push({ kind: "agent", name: f.replace(/\.(md|json)$/, ""), description: `agent definition ${f}`, source: dir });
      }
    } catch { /* ignore */ }
  }

  // Commands.
  for (const dir of [
    join(process.env.HOME ?? "~", ".config", "opencode", "commands"),
    join(root, ".opencode", "commands"),
    join(root, ".opencode", "command"),
  ]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        caps.push({ kind: "command", name: f.replace(/\.md$/, ""), description: `slash command /${f.replace(/\.md$/, "")}`, source: dir });
      }
    } catch { /* ignore */ }
  }

  // MCP servers declared in opencode.json / opencode.jsonc.
  for (const f of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json"]) {
    try {
      const p = join(root, f);
      if (!existsSync(p)) continue;
      const parsed = JSON.parse(readFileSync(p, "utf8").replace(/\/\/.*$/gm, "")) as {
        mcp?: Record<string, { description?: string }>;
      };
      for (const [name, cfg] of Object.entries(parsed.mcp ?? {})) {
        caps.push({ kind: "mcp", name, description: cfg?.description ?? `MCP server ${name}`, source: f });
      }
    } catch { /* config best-effort */ }
  }

  // Plugins.
  for (const dir of [join(root, ".opencode", "plugins")]) {
    try {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!/\.(js|ts|mjs)$/.test(f)) continue;
        caps.push({ kind: "plugin", name: f, description: `project plugin ${f}`, source: dir });
      }
    } catch { /* ignore */ }
  }

  // Testing capability probe: presence of test configs.
  const testMarkers = ["package.json", "pytest.ini", "pyproject.toml", "go.mod", "Cargo.toml", "vitest.config.ts", "jest.config.js"];
  if (testMarkers.some((m) => existsSync(join(root, m)))) {
    caps.push({ kind: "runtime", name: "testing", description: "test runner configuration detected", source: "probe" });
  }

  return { at: new Date().toISOString(), capabilities: caps };
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "your", "you", "are"]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * Pass 2: relevance scoring of metadata against goal text. Only loads what
 * scores above threshold — never a blanket dump.
 */
export function selectRelevantCapabilities(
  inventory: CapabilityInventory,
  goalText: string,
  limit = 8
): Array<Capability & { score: number; reason: string }> {
  const gt = tokens(goalText);
  const scored = inventory.capabilities.map((c) => {
    const ct = tokens(`${c.name} ${c.description} ${c.kind}`);
    let overlap = 0;
    for (const t of gt) if (ct.has(t)) overlap++;
    // Kind prior breaks ties only — relevance REQUIRES token overlap, so
    // irrelevant skills are rejected rather than admitted on prior alone.
    const prior = c.kind === "skill" ? 0.5 : c.kind === "tool" || c.kind === "runtime" ? 0.3 : 0.1;
    const score = overlap + prior;
    return { ...c, score, overlap, reason: `token overlap (${overlap}) with goal` };
  });
  return scored
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    .filter((s) => s.overlap > 0)
    .slice(0, limit);
}
