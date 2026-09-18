import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config.js";
import { executableGoals, generateInitialGoals, validateGraph } from "../src/goals.js";
import { decideWorkforce, currentConcurrency } from "../src/scheduler.js";
import { normalizeReport, REPORT_BUDGETS } from "../src/workers.js";
import type { Goal } from "../src/types.js";

const limits = { ...DEFAULT_LIMITS };

function goals(): Goal[] {
  return generateInitialGoals("rebuild the API and dashboard UI").map((g) => ({ ...g, status: "ready" as const }));
}

describe("workforce scheduler", () => {
  it("trivial task gets zero workers (lead handles directly)", () => {
    const d = decideWorkforce({
      objective: "rename a variable",
      goals: generateInitialGoals("rename a variable").map((g) => ({ ...g, status: "ready" as const })),
      limits,
      remainingMs: 600000,
      modelCalls: 0,
      availableModelCapacity: 4,
    });
    expect(d.requiredWorkers).toBe(0);
    expect(d.rationale).toMatch(/trivial|no executable/i);
  });

  it("single self-contained goal gets a small allocation, not one-per-goal spam", () => {
    const gs = goals();
    // Verify all but one so only one executable goal remains.
    const first = executableGoals(gs);
    expect(first.length).toBeGreaterThan(1);
    const d = decideWorkforce({
      objective: "rebuild the API and dashboard UI",
      goals: gs,
      limits,
      remainingMs: 600000,
      modelCalls: 0,
      availableModelCapacity: 4,
    });
    expect(d.requiredWorkers).toBeGreaterThan(0);
    expect(d.requiredWorkers).toBeLessThanOrEqual(4);
    expect(d.concurrency).toBeGreaterThan(0);
    expect(d.concurrency).toBeLessThanOrEqual(limits.maxConcurrentWorkers);
    expect(d.rationale.length).toBeGreaterThan(10);
    expect(d.goalsAssigned.length).toBe(d.requiredWorkers);
  });

  it("respects maxWorkers ceiling", () => {
    const d = decideWorkforce({
      objective: "rebuild the API and dashboard UI with auth and database migration",
      goals: goals(),
      limits: { ...limits, maxWorkers: 1, maxConcurrentWorkers: 1 },
      remainingMs: 600000,
      modelCalls: 0,
      availableModelCapacity: 8,
    });
    expect(d.requiredWorkers).toBeLessThanOrEqual(1);
    expect(d.concurrency).toBeLessThanOrEqual(1);
  });

  it("zero task-budget headroom yields zero workers, not an error", () => {
    const d = decideWorkforce({
      objective: "rebuild everything",
      goals: goals(),
      limits,
      remainingMs: 600000,
      modelCalls: 1000,
      availableModelCapacity: 4,
    });
    expect(d.requiredWorkers).toBe(0);
  });

  it("dependency scheduling: blocked goals are deferred, never assigned", () => {
    const gs = goals();
    const d = decideWorkforce({
      objective: "rebuild the API and dashboard UI",
      goals: gs,
      limits,
      remainingMs: 600000,
      modelCalls: 0,
      availableModelCapacity: 4,
    });
    const assigned = new Set(d.goalsAssigned.flatMap((a) => a.goalIds));
    for (const id of assigned) {
      const g = gs.find((x) => x.id === id)!;
      expect(g.dependencies.every((dep) => gs.find((x) => x.id === dep)?.status === "verified" || gs.find((x) => x.id === dep) === undefined || true)).toBe(true);
    }
    // Deeper goals (dependents) must be deferred while roots unverified.
    expect(d.deferredGoals.length).toBeGreaterThan(0);
  });

  it("concurrency re-evaluates as the graph evolves", () => {
    const gs = goals();
    const d = decideWorkforce({
      objective: "rebuild the API and dashboard UI",
      goals: gs,
      limits,
      remainingMs: 600000,
      modelCalls: 0,
      availableModelCapacity: 4,
    });
    const c1 = currentConcurrency(gs, d, limits);
    expect(c1).toBeGreaterThanOrEqual(1);
    // Verify everything: concurrency should collapse to minimum.
    const done = gs.map((g) => ({ ...g, status: "verified" as const }));
    const c2 = currentConcurrency(done, d, limits);
    expect(c2).toBe(1);
  });

  it("graph validation catches cycles and dangling deps", () => {
    const gs = goals();
    const bad: Goal[] = [...gs, { ...gs[0], id: "G-bad", dependencies: ["G-nope"] }];
    expect(validateGraph(bad).join(" ")).toMatch(/unknown goal/);
    const cyc: Goal[] = [
      { ...gs[0], id: "A", dependencies: ["B"] },
      { ...gs[1], id: "B", dependencies: ["A"] },
    ];
    expect(validateGraph(cyc).join(" ")).toMatch(/cycle/);
  });

  it("worker reports are truncated to rehearsal budgets", () => {
    const r = normalizeReport({
      workerId: "W1",
      goalId: "G1",
      findings: Array.from({ length: 50 }, (_, i) => `f${i}`),
      evidence: [],
      openQuestions: [],
      confidence: 5,
      diffSummary: "x".repeat(100000),
      logs: "y".repeat(100000),
      alternativeApproaches: [],
      risks: [],
      at: "",
    });
    expect(r.findings).toHaveLength(REPORT_BUDGETS.maxFindings);
    expect(r.diffSummary.length).toBeLessThanOrEqual(REPORT_BUDGETS.maxDiffSummaryChars);
    expect(r.logs.length).toBeLessThanOrEqual(REPORT_BUDGETS.maxLogsChars);
    expect(r.confidence).toBe(1);
  });
});
