import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGauntlet } from "../src/gauntlet.js";
import { planRemediation, CycleGuard } from "../src/remediation.js";
import { synthesize } from "../src/rehearsal.js";
import { applyGauntletVerdicts, verifyCompletion } from "../src/verification.js";
import { generateInitialGoals } from "../src/goals.js";
import type { Goal } from "../src/types.js";

function testGoals(): Goal[] {
  return generateInitialGoals("fix the thing").map((g) => ({ ...g, status: "in_review" as const }));
}

describe("gauntlet", () => {
  it("flags unevidenced progress claims", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-g-"));
    const r = runGauntlet(root, testGoals(), { round: 1, runTests: false });
    expect(r.findings.some((f) => f.category === "evidence")).toBe(true);
    expect(r.round).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("detects real issues: eval, hard-coded password, missing viewport", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-g-"));
    writeFileSync(join(root, "app.js"), "const x = eval(userInput);\nconst password = \"hunter2\";\n");
    writeFileSync(join(root, "index.html"), "<html><head></head><body><img src=a.png></body></html>");
    const goals: Goal[] = [
      { ...testGoals()[0], description: "Implement responsive UI dashboard", status: "in_review", evidence: [{ kind: "note", summary: "built", passed: true, at: new Date().toISOString() }] },
    ];
    const r = runGauntlet(root, goals, { round: 1, runTests: false });
    const cats = r.findings.map((f) => f.category);
    expect(cats).toContain("security");
    expect(r.findings.some((f) => f.severity === "critical")).toBe(true);
    expect(r.passed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails a broken test suite and passes a green one", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-g-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test", "t.test.js"), "const {test} = require('node:test');\ntest('fails', () => { throw new Error('boom'); });\n");
    const r1 = runGauntlet(root, testGoals(), { round: 1, runTests: true });
    expect(r1.findings.some((f) => f.category === "tests")).toBe(true);
    writeFileSync(join(root, "test", "t.test.js"), "const {test} = require('node:test');\ntest('passes', () => {});\n");
    const r2 = runGauntlet(root, testGoals(), { round: 2, runTests: true });
    expect(r2.findings.some((f) => f.category === "tests")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("no blind infinite loop: round ceiling enforced by controller; remediation plans serialize dependents", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-g-"));
    const r = runGauntlet(root, testGoals(), { round: 1, runTests: false });
    const plans = planRemediation(r.findings, testGoals());
    expect(plans.length).toBe(r.findings.filter((f) => f.status === "open").length);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("cycle guard", () => {
  it("halts on recurring file-state hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-c-"));
    writeFileSync(join(root, "a.txt"), "v1");
    const guard = new CycleGuard();
    const fp = guard.fingerprint(["a.txt"], root);
    expect(guard.observe(fp)).toBe(false);
    writeFileSync(join(root, "a.txt"), "v2");
    const fp2 = guard.fingerprint(["a.txt"], root);
    expect(guard.observe(fp2)).toBe(false);
    writeFileSync(join(root, "a.txt"), "v1"); // oscillate back
    expect(guard.observe(fp)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("rehearsal + verification", () => {
  it("synthesizes agreement/disagreement deterministically", () => {
    const at = new Date().toISOString();
    const s = synthesize([
      { workerId: "W1", goalId: "G1", findings: ["use postgres index on widgets"], evidence: [{ kind: "note", summary: "e", passed: true, at }], openQuestions: [], confidence: 0.9, diffSummary: "", logs: "", alternativeApproaches: ["mysql"], risks: ["r1"], at },
      { workerId: "W2", goalId: "G1", findings: ["use postgres index on widgets table"], evidence: [{ kind: "note", summary: "e", passed: true, at }], openQuestions: [], confidence: 0.8, diffSummary: "", logs: "", alternativeApproaches: [], risks: [], at },
      { workerId: "W3", goalId: "G2", findings: ["rewrite everything in cobol immediately"], evidence: [], openQuestions: ["why?"], confidence: 0.2, diffSummary: "", logs: "", alternativeApproaches: [], risks: [], at },
    ]);
    expect(s.workersConsulted).toBe(3);
    expect(s.agreement.length).toBeGreaterThan(0);
    expect(s.disagreement.length).toBeGreaterThan(0);
    expect(s.selectedApproach).toMatch(/W1/);
  });

  it("completion requires evidence + clean gauntlet, marks the rest uncertain", () => {
    const goals = testGoals().map((g, i) =>
      i === 0
        ? { ...g, status: "verified" as const, verificationState: "passed" as const, evidence: [{ kind: "note" as const, summary: "ok", passed: true, at: new Date().toISOString() }] }
        : g
    );
    const v = verifyCompletion(goals, { passed: false, goalVerdicts: [], findings: [{ id: "F1", goalId: goals[1].id, title: "t", evidence: "e", severity: "high", requiredRemediation: "r", category: "c", status: "open", at: new Date().toISOString() }], round: 1, at: new Date().toISOString() });
    expect(v.complete).toBe(false);
    expect(v.blockingFindings).toContain("F1");
    expect(v.uncertainGoals.length).toBeGreaterThan(0);
  });

  it("gauntlet verdicts verify evidenced goals and block failed ones", () => {
    const at = new Date().toISOString();
    const goals = testGoals().map((g) => ({ ...g, evidence: [{ kind: "note" as const, summary: "e", passed: true, at }] }));
    const updated = applyGauntletVerdicts(goals, {
      passed: true,
      goalVerdicts: goals.map((g) => ({ goalId: g.id, passed: true })),
      findings: [],
      round: 1,
      at,
    });
    expect(updated.every((g) => g.status === "verified")).toBe(true);
  });
});
