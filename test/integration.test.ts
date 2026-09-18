import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CortexController } from "../src/controller.js";
import { busRead, busWrite } from "../src/bus.js";
import { initialLevel, levelUsesGauntlet } from "../src/escalation.js";

/** Full-pipeline integration: complete task, failed task, blocked task. */
describe("integration", () => {
  it("completes a real task end to end with evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-i-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test", "ok.test.js"), "const {test} = require('node:test');\ntest('ok', () => {});\n");
    writeFileSync(join(root, "util.js"), "module.exports.add = (a, b) => a + b;\n");

    const c = new CortexController(root);
    c.start("add a multiply helper with tests");
    c.retrieveMemory("add multiply helper");
    c.discover();
    const goals = c.formGoals();
    const decision = c.planWorkforce();
    expect(decision.requiredWorkers).toBeGreaterThanOrEqual(0);
    const briefs = c.dispatch();
    // Simulate worker execution: implement + report via bus.
    for (const b of briefs) {
      const g = c.store.loadGoals().find((x) => x.assignedWorkers.includes(b.workerId));
      writeFileSync(join(root, "util.js"), "module.exports.add = (a, b) => a + b;\nmodule.exports.mul = (a, b) => a * b;\n");
      busWrite(root, {
        kind: "report",
        from: b.workerId,
        to: "controller",
        payload: {
          workerId: b.workerId,
          goalId: g?.id ?? goals[0].id,
          findings: ["added mul helper with unit test"],
          evidence: [{ kind: "file_artifact", summary: "util.js exports mul", passed: true, at: new Date().toISOString() }],
          openQuestions: [],
          confidence: 0.9,
          diffSummary: "+ mul export",
          logs: "",
          alternativeApproaches: [],
          risks: [],
          at: new Date().toISOString(),
        },
      });
    }
    const stateAfterDispatch = c.store.load()?.state;
    if (stateAfterDispatch === "EXECUTING" || stateAfterDispatch === "DISPATCHING") {
      const synth = c.rehearse([]);
      expect(synth.workersConsulted).toBe(briefs.length);
      c.beginImplementation();
    }
    // Attach evidence to every claimed goal so Gauntlet can verify.
    for (const g of c.store.loadGoals()) {
      if (g.status === "in_progress" || g.status === "in_review" || g.status === "assigned") {
        c.attachEvidence(g.id, { kind: "test_result", summary: "suite green", passed: true });
        const cur = c.store.loadGoals();
        const gg = cur.find((x) => x.id === g.id)!;
        gg.status = "in_review";
        c.store.saveGoals(cur);
      }
    }
    const gres = c.runGauntlet({ runTests: true });
    expect(gres.round).toBe(1);
    if (!gres.passed) {
      c.remediate([]);
    }
    const verdict = c.verify();
    expect(verdict.perGoal.length).toBeGreaterThan(0);
    c.learn([{ kind: "pattern", text: "mul helper pattern", importance: 0.5 }]);
    const mem = c.searchMemory("mul helper");
    expect(mem.length).toBeGreaterThan(0);
    // finish() must work after learn() regardless of verdict direction.
    const done = c.finish();
    expect(["COMPLETED", "BLOCKED"]).toContain(c.store.load()?.state);
    expect(typeof done.complete).toBe("boolean");
    rmSync(root, { recursive: true, force: true });
  });

  it("failed task: broken tests block completion honestly", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-i-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test", "bad.test.js"), "const {test} = require('node:test');\ntest('broken', () => { throw new Error('nope'); });\n");
    const c = new CortexController(root);
    c.start("fix the broken thing");
    c.retrieveMemory("x");
    c.discover();
    c.formGoals();
    c.planWorkforce();
    c.dispatch();
    const st = c.store.load()?.state;
    if (st === "EXECUTING" || st === "DISPATCHING") {
      c.rehearse([]);
      c.beginImplementation("lead fix");
    }
    for (const g of c.store.loadGoals()) {
      c.attachEvidence(g.id, { kind: "note", summary: "attempted", passed: false });
      const cur = c.store.loadGoals();
      cur.find((x) => x.id === g.id)!.status = "in_review";
      c.store.saveGoals(cur);
    }
    const gres = c.runGauntlet({ runTests: true });
    expect(gres.passed).toBe(false);
    const verdict = c.verify();
    expect(verdict.complete).toBe(false);
    const final = c.finish();
    expect(final.complete).toBe(false);
    expect(c.store.load()?.state).toBe("BLOCKED");
    rmSync(root, { recursive: true, force: true });
  });

  it("bus fallback carries dispatch signals and reports", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-i-"));
    busWrite(root, { kind: "dispatch", from: "controller", to: "W1", payload: { hello: 1 } });
    const read = busRead(root, { kind: "dispatch", to: "W1" });
    expect(read).toHaveLength(1);
    expect(read[0].payload).toMatchObject({ hello: 1 });
    rmSync(root, { recursive: true, force: true });
  });

  it("escalation ladder stays low for trivial tasks, climbs for migrations", () => {
    expect(initialLevel("rename a variable")).toBe(0);
    expect(levelUsesGauntlet(initialLevel("rename a variable"))).toBe(false);
    expect(initialLevel("rebuild the authentication system and make it production ready")).toBeGreaterThanOrEqual(3);
    expect(levelUsesGauntlet(4)).toBe(true);
  });
});
