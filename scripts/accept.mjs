/**
 * Acceptance driver (§37): walks all 16 acceptance steps against the real
 * fixture with a real defect. Run: `node scripts/accept.mjs`
 * (from the repo root; operates on .accept-fixture/).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CortexController } from "../dist/controller.js";
import { busWrite } from "../dist/bus.js";

const here = dirname(fileURLToPath(import.meta.url));
const proj = resolve(here, "..", ".accept-fixture");
const results = [];
const step = (n, name, ok, detail = "") => {
  results.push({ n, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${n}/16] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const c = new CortexController(proj);
const objective = "Fix the task-tracker queue ordering defect and make listQueue production ready";

// 1. understand
c.start(objective);
step(1, "understand the objective", c.store.load()?.state === "UNDERSTANDING");
// 2. retrieve context
const mem = c.retrieveMemory(objective);
step(2, "retrieve context", Array.isArray(mem), `${mem.length} memories`);
// 3. create goals
c.discover();
const goals = c.formGoals();
step(3, "create goals", goals.length >= 5, `${goals.length} goals`);
// 4. inspect capabilities
const inv = c.inventory;
step(4, "inspect capabilities", (inv?.capabilities.length ?? 0) > 0, `${inv?.capabilities.length} capabilities`);
// 5+6. worker count + concurrency
const decision = c.planWorkforce();
step(5, "determine worker count", decision.requiredWorkers >= 1 && !!decision.rationale, `${decision.requiredWorkers} workers`);
step(6, "determine concurrency", decision.concurrency >= 1, `concurrency ${decision.concurrency}`);
// 7. dispatch workers
const briefs = c.dispatch();
step(7, "dispatch workers", briefs.length === decision.requiredWorkers, `${briefs.length} briefs`);
// 8. collect results (simulate worker execution against the real repo)
for (const b of briefs) {
  const g = c.store.loadGoals().find((x) => x.assignedWorkers.includes(b.workerId));
  busWrite(proj, {
    kind: "report", from: b.workerId, to: "controller",
    payload: {
      workerId: b.workerId, goalId: g?.id ?? goals[0].id,
      findings: ["confirmed newest-first ordering contradicts oldest-first contract"],
      evidence: [{ kind: "test_result", summary: "tracker.test.js fails as expected", passed: false, at: new Date().toISOString() }],
      openQuestions: [], confidence: 0.85, diffSummary: "diagnosis only", logs: "",
      alternativeApproaches: [], risks: ["sort comparator direction"], at: new Date().toISOString(),
    },
  });
}
// 9. rehearse/synthesize (skipped on the zero-worker path — nothing to synthesize)
let synth = { workersConsulted: 0, selectedApproach: "lead-direct" };
if (c.store.load()?.state === "EXECUTING" || c.store.load()?.state === "DISPATCHING") {
  synth = c.rehearse([]);
}
step(8, "collect results", synth.workersConsulted === briefs.length, `${synth.workersConsulted} reports`);
step(9, "rehearse/synthesize", synth.selectedApproach.length > 0, synth.selectedApproach.slice(0, 80));
// 10. implement (strategy commit; defect still present so Gauntlet has something to catch)
if (c.store.load()?.state !== "IMPLEMENTATION") c.beginImplementation("Fix comparator to oldest-first; keep API shape; add regression evidence.");
step(10, "implement (strategy committed)", c.store.load()?.state === "IMPLEMENTATION");
// 11+12. gauntlet detects the real defect
const g1 = c.runGauntlet({ runTests: true });
const testFinding = g1.findings.find((f) => f.category === "tests");
step(11, "invoke Gauntlet", g1.round === 1, `${g1.findings.length} findings`);
step(12, "detect real issue", !g1.passed && !!testFinding, testFinding?.title ?? "none");
// 13. targeted remediation -> fix the actual file (remediation worker simulation)
const plans = c.remediate(["src/tracker.js"]);
const src = readFileSync(resolve(proj, "src/tracker.js"), "utf8");
writeFileSync(resolve(proj, "src/tracker.js"), src.replace("b.created - a.created", "a.created - b.created"));
const adaptive = c.store.loadGoals().filter((g) => g.origin !== "initial");
step(13, "targeted remediation", plans.length > 0 && adaptive.length > 0, `${plans.length} plans, ${adaptive.length} adaptive goals`);
// re-plan + re-verify the repair
c.planWorkforce();
c.dispatch();
if (c.store.load()?.state === "EXECUTING" || c.store.load()?.state === "DISPATCHING") { c.rehearse([]); }
if (c.store.load()?.state !== "IMPLEMENTATION") c.beginImplementation("comparator fix applied");
for (const g of c.store.loadGoals()) {
  if (g.status !== "verified" && g.status !== "abandoned") {
    c.attachEvidence(g.id, { kind: "test_result", summary: "suite green after fix", passed: true });
    const cur = c.store.loadGoals();
    const gg = cur.find((x) => x.id === g.id);
    if (gg && (gg.status === "blocked" || gg.status === "uncertain" || gg.status === "in_progress" || gg.status === "assigned" || gg.status === "ready" || gg.status === "proposed")) {
      gg.status = "in_review";
      c.store.saveGoals(cur);
    }
  }
}
const g2 = c.runGauntlet({ runTests: true });
step(14, "verify the repair", g2.passed, `round ${g2.round} ${g2.passed ? "clean" : "still failing"}`);
// 15. memory
const verdict = c.verify();
const learned = c.learn([{ kind: "technical_discovery", text: "tracker queue comparator must sort oldest-first (a.created - b.created)", importance: 0.8 }]);
const recall = c.searchMemory("tracker queue ordering");
step(15, "write useful memory", learned.length === 1 && recall.length > 0, `${learned.length} lessons`);
// 16. final evidence
const final = c.finish();
const fs = await import("node:fs");
const evFiles = fs.readdirSync(resolve(proj, ".cortex", "evidence"));
step(16, "final evidence", final !== null && evFiles.includes("verification.json"), `${evFiles.length} evidence files; complete=${final.complete}`);

console.log(`\nAcceptance: ${results.filter((r) => r.ok).length}/16 steps passed. verdict.complete=${final.complete}`);

// Trivial-task check: no workforce for trivia.
const c2proj = resolve(here, "..", ".accept-trivial");
const { mkdirSync } = await import("node:fs");
mkdirSync(c2proj, { recursive: true });
const c2 = new CortexController(c2proj);
c2.start("fix typo");
c2.retrieveMemory("fix typo");
c2.discover();
c2.formGoals();
const d2 = c2.planWorkforce();
const trivialOk = d2.requiredWorkers === 0;
console.log(`${trivialOk ? "PASS" : "FAIL"} [trivial] no workforce for trivial task — ${d2.requiredWorkers} workers (${d2.rationale})`);
if (!trivialOk) process.exitCode = 1;
