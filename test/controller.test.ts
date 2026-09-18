import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CortexController } from "../src/controller.js";
import { StateStore } from "../src/state.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "cortex-ctl-"));
}

describe("controller state machine", () => {
  it("rejects illegal transitions", () => {
    const root = freshRoot();
    const s = new StateStore(root);
    s.init("obj", "r1");
    expect(() => s.transition("GAUNTLET", "skip")).toThrow(/illegal transition/);
    rmSync(root, { recursive: true, force: true });
  });

  it("records transitions with evidence + timestamps", () => {
    const root = freshRoot();
    const s = new StateStore(root);
    s.init("obj", "r1");
    s.transition("UNDERSTANDING", "start", "objective.json");
    const t = s.readTransitions();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ from: "IDLE", to: "UNDERSTANDING", event: "start", evidenceRef: "objective.json" });
    expect(typeof t[0].at).toBe("string");
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers persisted state across instances", () => {
    const root = freshRoot();
    const c1 = new CortexController(root);
    c1.start("rebuild the widget");
    const c2 = new CortexController(root);
    expect(c2.store.load()?.objective).toBe("rebuild the widget");
    expect(c2.store.load()?.state).toBe("UNDERSTANDING");
    rmSync(root, { recursive: true, force: true });
  });

  it("tracks objective through the deterministic prefix", () => {
    const root = freshRoot();
    const c = new CortexController(root);
    c.start("add dark mode to settings page");
    expect(c.store.load()?.state).toBe("UNDERSTANDING");
    c.retrieveMemory("add dark mode to settings page");
    expect(c.store.load()?.state).toBe("MEMORY_RETRIEVAL");
    c.discover();
    expect(c.store.load()?.state).toBe("CAPABILITY_DISCOVERY");
    const goals = c.formGoals();
    expect(goals.length).toBeGreaterThan(3);
    expect(c.store.load()?.state).toBe("GOAL_FORMATION");
    rmSync(root, { recursive: true, force: true });
  });

  it("generates UI goals for UI objectives", () => {
    const root = freshRoot();
    const c = new CortexController(root);
    c.start("rebuild the dashboard UI with responsive layout");
    c.retrieveMemory("x");
    c.discover();
    const goals = c.formGoals();
    const descs = goals.map((g) => g.description).join(" ");
    expect(descs).toMatch(/responsive/i);
    expect(descs).toMatch(/accessibility/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("adaptive goals respect ceilings", () => {
    const root = freshRoot();
    const c = new CortexController(root, { limits: { maxDynamicGoals: 1 } as never });
    c.start("fix login bug");
    c.retrieveMemory("x");
    c.discover();
    const goals = c.formGoals();
    c.planWorkforce();
    c.dispatch();
    // Drive to gauntlet: rehearse empty then implement.
    const st = c.store.load()?.state;
    if (st === "EXECUTING") {
      c.rehearse([]);
      c.beginImplementation("test");
    }
    c.runGauntlet({ runTests: false });
    c.remediate([]);
    const after = c.store.loadGoals().filter((g) => g.origin !== "initial");
    expect(after.length).toBeLessThanOrEqual(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("guard rejects forbidden model proposals", () => {
    for (const a of ["bypass_gauntlet", "declare_complete_without_evidence", "disable_memory_safety", "bypass_resource_limits"]) {
      expect(CortexController.guardProposal(a).allowed).toBe(false);
    }
    expect(CortexController.guardProposal("propose_new_goal").allowed).toBe(true);
  });

  it("pause/resume round-trips", () => {
    const root = freshRoot();
    const c = new CortexController(root);
    c.start("do thing");
    c.pause();
    expect(c.store.load()?.state).toBe("PAUSED");
    c.resume();
    expect(c.store.load()?.state).toBe("WORKFORCE_PLANNING");
    rmSync(root, { recursive: true, force: true });
  });
});
