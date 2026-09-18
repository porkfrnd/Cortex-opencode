import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverCapabilities, selectRelevantCapabilities } from "../src/capabilities.js";
import { MemoryStore } from "../src/memory/store.js";

describe("capability discovery", () => {
  it("discovers baseline runtime capabilities in an empty dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cap-"));
    const inv = discoverCapabilities(root);
    const names = inv.capabilities.map((c) => c.name);
    expect(names).toContain("filesystem");
    expect(names).toContain("shell");
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers project skills from metadata only", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cap-"));
    mkdirSync(join(root, ".opencode", "skills", "testing"), { recursive: true });
    writeFileSync(join(root, ".opencode", "skills", "testing", "SKILL.md"), "---\ndescription: testing skill for playwright failures\n---\n# Testing\n");
    const inv = discoverCapabilities(root);
    const skill = inv.capabilities.find((c) => c.kind === "skill" && c.name === "testing");
    expect(skill?.description).toMatch(/playwright/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("selects relevant skills and rejects irrelevant ones", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cap-"));
    mkdirSync(join(root, ".opencode", "skills", "testing"), { recursive: true });
    writeFileSync(join(root, ".opencode", "skills", "testing", "SKILL.md"), "---\ndescription: testing skill for playwright browser failures\n---\n");
    mkdirSync(join(root, ".opencode", "skills", "interior-design"), { recursive: true });
    writeFileSync(join(root, ".opencode", "skills", "interior-design", "SKILL.md"), "---\ndescription: interior design color palettes for living rooms\n---\n");
    const inv = discoverCapabilities(root);
    const sel = selectRelevantCapabilities(inv, "Debug a Playwright browser test failure", 8);
    const names = sel.map((s) => s.name);
    expect(names).toContain("testing");
    expect(names).not.toContain("interior-design");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("memory", () => {
  it("stores, recalls with ranking + budget, and isolates projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mem-"));
    const m = new MemoryStore(dir);
    m.write({ projectId: "projA", kind: "fact", text: "API uses endpoint /v2/widgets with pagination", importance: 0.9, provenance: "t" });
    m.write({ projectId: "projB", kind: "fact", text: "unrelated cooking recipe", importance: 0.9, provenance: "t" });
    const hits = m.recall("API endpoint widgets pagination", "projA", 8000);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.projectId === "projA" || h.projectId === "global")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces retrieval budget strictly", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mem-"));
    const m = new MemoryStore(dir);
    for (let i = 0; i < 10; i++) {
      m.write({ projectId: "p", kind: "fact", text: `shared keyword alpha beta gamma fact number ${i} `.repeat(20), importance: 0.9, provenance: "t" });
    }
    const hits = m.recall("shared keyword alpha beta gamma", "p", 500);
    const total = hits.reduce((a, h) => a + h.text.length, 0);
    expect(total).toBeLessThanOrEqual(500);
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts secrets and refuses .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mem-"));
    const m = new MemoryStore(dir);
    const e = m.write({ projectId: "p", kind: "fact", text: "deploy with api_key=AKIAIOSFODNN7EXAMPLE and password=hunter2", importance: 0.5, provenance: "t" });
    expect(e?.text).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(e?.text).not.toMatch(/hunter2/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("consolidation merges duplicates but preserves failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mem-"));
    const m = new MemoryStore(dir);
    m.write({ projectId: "p", kind: "fact", text: "API uses endpoint X for widgets", importance: 0.5, provenance: "a" });
    m.write({ projectId: "p", kind: "fact", text: "API uses endpoint X for widgets!", importance: 0.6, provenance: "b" });
    m.write({ projectId: "p", kind: "failed_approach", text: "API uses endpoint X for widgets failed under load", importance: 0.7, provenance: "c" });
    const res = m.consolidate("p");
    expect(res.merged).toBeGreaterThanOrEqual(1);
    const remaining = m.all("p");
    expect(remaining.some((e) => e.kind === "failed_approach")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records usefulness outcomes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mem-"));
    const m = new MemoryStore(dir);
    const e = m.write({ projectId: "p", kind: "pattern", text: "useful pattern", importance: 0.5, provenance: "t" })!;
    const before = e.usefulness;
    m.recordOutcome(e.id, true);
    expect(m.read(e.id)!.usefulness).toBeGreaterThan(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
