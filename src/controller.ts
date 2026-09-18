import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCapabilities, selectRelevantCapabilities, type CapabilityInventory } from "./capabilities.js";
import { resolveConfig, type CortexConfig } from "./config.js";
import { BudgetTracker, resolveModelTier } from "./budgets.js";
import { busClear } from "./bus.js";
import { initialLevel, levelUsesGauntlet, levelUsesWorkforce, type EscalationLevel } from "./escalation.js";
import { runGauntlet } from "./gauntlet.js";
import { createAdaptiveGoal, executableGoals, generateInitialGoals, validateGraph, type AdaptiveRequest } from "./goals.js";
import { MemoryStore } from "./memory/store.js";
import { redactSecrets } from "./redaction.js";
import { planRemediation, CycleGuard } from "./remediation.js";
import { synthesize, type RehearsalSynthesis } from "./rehearsal.js";
import { decideWorkforce } from "./scheduler.js";
import { StateStore } from "./state.js";
import { evidenceDir, memoryDir, projectIdentity } from "./paths.js";
import type {
  CompletionVerdict,
  CortexState,
  Evidence,
  GauntletResult,
  Goal,
  MemoryEntry,
  WorkforceDecision,
  WorkerReport,
} from "./types.js";
import { applyGauntletVerdicts, verifyCompletion } from "./verification.js";
import { buildBrief, collectReports, dispatchBriefs, normalizeReport, renderBriefText } from "./workers.js";

export interface CortexStatusView {
  objective: string;
  phase: CortexState;
  goals: Array<{ id: string; description: string; status: string; verification: string }>;
  workers: Array<{ id: string; role: string; goals: string[] }>;
  concurrency: string;
  next: string;
  budget: string;
  escalation: string;
}

/**
 * Cortex controller (§2–§4): the sole authority over the objective, goal
 * graph, dependencies, execution state, verification state, and completion.
 * The model is advisory — every proposal passes through here.
 */
export class CortexController {
  readonly store: StateStore;
  readonly memory: MemoryStore;
  readonly budgets: BudgetTracker;
  readonly config: CortexConfig;
  readonly projectId: string;
  inventory: CapabilityInventory | null = null;
  lastDecision: WorkforceDecision | null = null;
  lastRehearsal: RehearsalSynthesis | null = null;
  lastGauntlet: GauntletResult | null = null;
  lastVerdict: CompletionVerdict | null = null;
  private cycleGuard = new CycleGuard();
  private runId: string;

  constructor(
    readonly projectRoot: string,
    config?: Partial<CortexConfig>
  ) {
    this.config = resolveConfig(config);
    this.store = new StateStore(projectRoot);
    this.memory = new MemoryStore(memoryDir(projectRoot));
    this.budgets = new BudgetTracker(this.config.limits);
    this.projectId = projectIdentity(projectRoot);
    this.runId = `run-${Date.now().toString(36)}`;
    mkdirSync(evidenceDir(projectRoot), { recursive: true });
    this.rehydrate();
  }

  /** Recover in-memory artifacts from persisted evidence after a restart (§4). */
  private rehydrate(): void {
    const get = (n: string): unknown => {
      try {
        return this.readEvidence(n);
      } catch {
        return null;
      }
    };
    const decision = get("workforce-decision.json") as WorkforceDecision | null;
    if (decision && typeof decision.requiredWorkers === "number") this.lastDecision = decision;
    const rehearsal = get("rehearsal.json") as RehearsalSynthesis | null;
    if (rehearsal && typeof rehearsal.workersConsulted === "number") this.lastRehearsal = rehearsal;
    const st = this.store.load();
    if (st) {
      this.runId = st.runId;
      // Latest gauntlet round evidence wins.
      for (let r = this.config.limits.maxGauntletRounds + 2; r >= 1; r--) {
        const g = get(`gauntlet-r${r}.json`) as GauntletResult | null;
        if (g && typeof g.round === "number") {
          this.lastGauntlet = g;
          break;
        }
      }
      const verdict = get("verification.json") as CompletionVerdict | null;
      if (verdict && typeof verdict.complete === "boolean") this.lastVerdict = verdict;
      this.budgets.usage.goalCount = this.store.loadGoals().length;
      this.budgets.usage.dynamicGoals = this.store.loadGoals().filter((x) => x.origin !== "initial").length;
    }
  }

  // ---- pipeline stages ----

  start(objective: string): CortexStatusView {
    const clean = redactSecrets(objective).text;
    this.runId = `run-${Date.now().toString(36)}`;
    busClear(this.projectRoot);
    this.store.init(clean, this.runId);
    this.store.transition("UNDERSTANDING", "objective received");
    const st = this.store.load()!;
    st.escalationLevel = initialLevel(clean);
    this.store.save(st);
    this.writeEvidence("objective.json", { objective: clean, runId: this.runId, escalationLevel: st.escalationLevel });
    return this.status();
  }

  retrieveMemory(objective: string): MemoryEntry[] {
    this.requireState("UNDERSTANDING");
    const found = this.memory.recall(objective, this.projectId, this.config.memory.retrievalBudgetChars);
    this.writeEvidence("memory-retrieved.json", found.map((e) => ({ id: e.id, kind: e.kind, text: e.text })));
    this.store.transition("MEMORY_RETRIEVAL", "memory retrieved", "memory-retrieved.json");
    return found;
  }

  discover(): CapabilityInventory {
    this.requireState("MEMORY_RETRIEVAL");
    this.inventory = discoverCapabilities(this.projectRoot); // cached per run (§26)
    this.writeEvidence("capabilities.json", this.inventory);
    this.store.transition("CAPABILITY_DISCOVERY", "capabilities discovered", "capabilities.json");
    return this.inventory;
  }

  formGoals(objective?: string): Goal[] {
    this.requireState("CAPABILITY_DISCOVERY");
    const obj = objective ?? this.store.load()?.objective ?? "";
    const goals = generateInitialGoals(redactSecrets(obj).text).map((g) => ({ ...g, status: "ready" as const }));
    const errs = validateGraph(goals);
    if (errs.length) throw new Error(`cortex: invalid initial graph: ${errs.join("; ")}`);
    this.store.saveGoals(goals);
    this.budgets.usage.goalCount = goals.length;
    this.writeEvidence("goals.json", goals);
    this.store.transition("GOAL_FORMATION", "goal graph formed", "goals.json");
    return goals;
  }

  planWorkforce(): WorkforceDecision {
    this.requireState("GOAL_FORMATION", "WORKFORCE_PLANNING", "REMEDIATION", "VERIFICATION", "BLOCKED", "REHEARSAL");
    const goals = this.store.loadGoals();
    const level = (this.store.load()?.escalationLevel ?? 1) as EscalationLevel;
    if (!levelUsesWorkforce(level)) {
      const d: WorkforceDecision = {
        requiredWorkers: 0,
        concurrency: 1,
        rationale: `escalation level ${level}: lead handles directly`,
        goalsAssigned: [],
        executableGoals: executableGoals(goals).map((g) => g.id),
        deferredGoals: [],
        at: new Date().toISOString(),
      };
      this.lastDecision = d;
      this.writeEvidence("workforce-decision.json", d);
      this.store.transition("WORKFORCE_PLANNING", "workforce planned (direct)", "workforce-decision.json");
      return d;
    }
    const downgrade = this.budgets.downgrade();
    const st = this.store.load()!;
    const remainingMs = Math.max(0, this.config.limits.maxExecutionMs - (Date.now() - Date.parse(st.createdAt)));
    const decision = decideWorkforce({
      objective: st.objective,
      goals,
      limits: { ...this.config.limits, maxWorkers: downgrade.maxWorkers, maxConcurrentWorkers: downgrade.maxConcurrent },
      remainingMs,
      modelCalls: this.budgets.usage.modelCalls,
      availableModelCapacity: this.config.limits.maxConcurrentWorkers,
    });
    this.lastDecision = decision;
    this.budgets.usage.workerCount += decision.requiredWorkers;
    this.writeEvidence("workforce-decision.json", decision);
    // BLOCKED/REMEDIATION/VERIFICATION/REHEARSAL can re-plan without violating the machine.
    this.store.transition("WORKFORCE_PLANNING", "workforce planned", "workforce-decision.json");
    return decision;
  }

  /** Build worker briefs (per-worker skills/tools/constraints, §8) and publish dispatch signals. */
  dispatch(): Array<{ workerId: string; text: string }> {
    this.requireState("WORKFORCE_PLANNING");
    const decision = this.lastDecision;
    if (!decision) throw new Error("cortex: plan workforce before dispatch");
    const goals = this.store.loadGoals();
    const out: Array<{ workerId: string; text: string }> = [];
    const briefs: Array<{ brief: ReturnType<typeof buildBrief>; text: string }> = [];
    for (const a of decision.goalsAssigned) {
      const relevant = (this.inventory ? selectRelevantCapabilities(this.inventory, a.goalIds.map((id) => goals.find((g) => g.id === id)?.description ?? "").join(" ")) : []).map((c) => c.name);
      const brief = buildBrief({
        role: a.workerRole,
        goalIds: a.goalIds,
        goals,
        skills: relevant.filter((r) => !["read", "write", "edit", "bash", "grep", "glob"].includes(r)),
        tools: ["read", "grep", "glob", "bash"],
        constraints: [
          "Scope file edits to your assigned goal only.",
          "Never persist secrets; never read .env contents.",
          "Report evidence; flag uncertainty explicitly.",
        ],
        modelTier: a.modelTier,
      });
      const text = renderBriefText(brief, goals);
      briefs.push({ brief, text });
      out.push({ workerId: brief.workerId, text });
      // Mark goals assigned (controller-side, not worker-claimed).
      for (const id of a.goalIds) {
        const g = goals.find((x) => x.id === id);
        if (g && (g.status === "ready" || g.status === "proposed")) {
          g.status = "assigned";
          g.assignedWorkers = [...g.assignedWorkers, brief.workerId];
          g.updatedAt = new Date().toISOString();
        }
      }
    }
    this.store.saveGoals(goals);
    dispatchBriefs(this.projectRoot, briefs);
    this.budgets.addModelCalls(Math.max(1, out.length));
    this.writeEvidence("dispatch.json", out.map((o) => o.workerId));
    this.store.transition("DISPATCHING", `dispatched ${out.length} workers`, "dispatch.json");
    if (out.length === 0) {
      // Zero-worker path: lead proceeds straight to implementation.
      this.store.transition("IMPLEMENTATION", "zero workers: lead implements directly");
    } else {
      this.store.transition("EXECUTING", "workers executing");
    }
    return out;
  }

  /** Collect structured worker reports from the bus and run rehearsal synthesis (§13). */
  rehearse(externalReports?: WorkerReport[]): RehearsalSynthesis {
    this.requireState("EXECUTING", "DISPATCHING");
    const st = this.store.load()!;
    const fromBus = collectReports(this.projectRoot, [], st.createdAt);
    const reports = [...fromBus, ...(externalReports ?? [])].map(normalizeReport);
    const synthesis = synthesize(reports);
    this.lastRehearsal = synthesis;
    this.writeEvidence("rehearsal.json", synthesis);
    // Mark reported goals in_review so Gauntlet treats them as claimed progress.
    const goals = this.store.loadGoals();
    for (const r of reports) {
      const g = goals.find((x) => x.id === r.goalId);
      if (g && (g.status === "assigned" || g.status === "in_progress")) {
        g.status = "in_review";
        g.updatedAt = new Date().toISOString();
      }
    }
    this.store.saveGoals(goals);
    this.store.transition("REHEARSAL", `rehearsed ${reports.length} reports`, "rehearsal.json");
    return synthesis;
  }

  /** Lead commits to the rehearsed strategy; parallel-safe implementation note. */
  beginImplementation(strategy?: string): void {
    this.requireState("REHEARSAL", "WORKFORCE_PLANNING", "DISPATCHING");
    const s = strategy ?? this.lastRehearsal?.selectedApproach ?? "lead strategy";
    this.writeEvidence("implementation-strategy.json", { strategy: redactSecrets(s).text, at: new Date().toISOString() });
    const goals = this.store.loadGoals();
    for (const g of goals) {
      if (g.status === "assigned" || g.status === "in_review") {
        g.status = "in_progress";
        g.updatedAt = new Date().toISOString();
      }
    }
    this.store.saveGoals(goals);
    this.store.transition("IMPLEMENTATION", "strategy committed", "implementation-strategy.json");
  }

  attachEvidence(goalId: string, evidence: Omit<Evidence, "at">): void {
    const goals = this.store.loadGoals();
    const g = goals.find((x) => x.id === goalId);
    if (!g) throw new Error(`cortex: unknown goal ${goalId}`);
    g.evidence.push({ ...evidence, summary: redactSecrets(evidence.summary).text, at: new Date().toISOString() });
    g.updatedAt = new Date().toISOString();
    this.store.saveGoals(goals);
  }

  runGauntlet(opts?: { runTests?: boolean; testCommand?: string }): GauntletResult {
    this.requireState("IMPLEMENTATION", "REMEDIATION");
    const goals = this.store.loadGoals();
    const round = (this.lastGauntlet?.round ?? 0) + 1;
    const ceiling = this.config.limits.maxGauntletRounds;
    if (round > ceiling) throw new Error(`cortex: gauntlet round ceiling reached (${ceiling}) — refusing blind loop`);
    const result = runGauntlet(this.projectRoot, goals, { round, runTests: opts?.runTests ?? true, testCommand: opts?.testCommand });
    this.lastGauntlet = result;
    this.budgets.usage.gauntletPasses = round;
    this.writeEvidence(`gauntlet-r${round}.json`, result);
    const updated = applyGauntletVerdicts(goals, result);
    this.store.saveGoals(updated);
    this.store.transition("GAUNTLET", `gauntlet round ${round}: ${result.passed ? "clean" : `${result.findings.length} findings`}`, `gauntlet-r${round}.json`);
    return result;
  }

  /** Targeted remediation (§17): findings -> plans -> adaptive goals. */
  remediate(touchedFiles: string[] = []): ReturnType<typeof planRemediation> {
    this.requireState("GAUNTLET", "VERIFICATION");
    const g = this.lastGauntlet;
    if (!g) throw new Error("cortex: no gauntlet result to remediate");
    if (touchedFiles.length) {
      const fp = this.cycleGuard.fingerprint(touchedFiles, this.projectRoot);
      if (this.cycleGuard.observe(fp)) {
        this.store.transition("BLOCKED", "stuck remediation cycle detected (file-state hash recurred)");
        throw new Error("cortex: stuck cycle — same file state recurred within 3 remediation rounds; run blocked with report");
      }
    }
    const goals = this.store.loadGoals();
    const plans = planRemediation(g.findings, goals);
    // Each open finding becomes a targeted goal (bounded by §6 ceilings).
    for (const p of plans) {
      const f = g.findings.find((x) => x.id === p.findingId)!;
      const { goal, rejected } = createAdaptiveGoal(
        this.store.loadGoals(),
        {
          title: f.title,
          description: `${f.title} — ${f.requiredRemediation}`,
          successCriteria: [f.requiredRemediation],
          dependsOn: [p.goalId],
          source: "gauntlet",
          severity: f.severity,
        },
        this.config.limits
      );
      if (goal) {
        const cur = this.store.loadGoals();
        cur.push(goal);
        this.store.saveGoals(cur);
        this.budgets.usage.dynamicGoals++;
        this.budgets.usage.goalCount = cur.length;
      } else {
        this.writeEvidence("adaptive-rejected.json", { finding: f.id, reason: rejected });
      }
      f.status = "remediating";
    }
    this.budgets.usage.remediationRounds++;
    this.writeEvidence("remediation-plan.json", plans);
    this.store.transition("REMEDIATION", `targeted remediation: ${plans.length} plans`, "remediation-plan.json");
    return plans;
  }

  verify(): CompletionVerdict {
    this.requireState("GAUNTLET", "REMEDIATION");
    const goals = this.store.loadGoals();
    const verdict = verifyCompletion(goals, this.lastGauntlet);
    this.lastVerdict = verdict;
    this.writeEvidence("verification.json", verdict);
    this.store.transition("VERIFICATION", verdict.summary, "verification.json");
    return verdict;
  }

  /** Async-friendly learning (§21): extract + persist compact lessons. */
  learn(lessons: Array<{ kind: MemoryEntry["kind"]; text: string; importance: number }>): MemoryEntry[] {
    this.requireState("VERIFICATION", "LEARNING");
    const written: MemoryEntry[] = [];
    for (const l of lessons.slice(0, 20)) {
      const e = this.memory.write({ projectId: this.projectId, kind: l.kind, text: l.text, importance: l.importance, provenance: `run:${this.runId}` });
      if (e) written.push(e);
    }
    this.writeEvidence("learning.json", written.map((e) => e.id));
    try {
      this.store.transition("LEARNING", `learned ${written.length} lessons`, "learning.json");
    } catch {
      // Already in LEARNING (verify->learn path lands here once); continue.
    }
    return written;
  }

  finish(): CompletionVerdict {
    const verdict = this.lastVerdict ?? verifyCompletion(this.store.loadGoals(), this.lastGauntlet);
    if (verdict.complete) {
      this.store.transition("COMPLETED", verdict.summary, "verification.json");
    } else {
      this.store.transition("BLOCKED", verdict.summary, "verification.json");
    }
    return verdict;
  }

  pause(): void {
    this.store.transition("PAUSED", "user requested pause");
  }

  resume(): void {
    const st = this.store.load();
    if (!st || st.state !== "PAUSED") throw new Error("cortex: nothing paused");
    // Return to a safe re-entry point: re-plan from current graph.
    this.store.transition("WORKFORCE_PLANNING", "resumed by user");
  }

  fail(reason: string): void {
    const st = this.store.load();
    if (!st) throw new Error("cortex: no active run");
    if (st.state === "COMPLETED" || st.state === "FAILED") return;
    // Route through BLOCKED (always legal) then FAILED.
    try {
      this.store.transition("BLOCKED", `failure: ${reason}`);
    } catch { /* already blocked */ }
    this.store.transition("FAILED", `failure: ${reason}`);
  }

  /** Model-facing guard: reject forbidden orchestration proposals (§2). */
  static guardProposal(action: string): { allowed: boolean; reason?: string } {
    const forbidden: Record<string, string> = {
      mark_unverified_goal_complete: "goals verify only via evidence + Gauntlet",
      bypass_resource_limits: "resource limits are controller-enforced",
      bypass_gauntlet: "Gauntlet is mandatory for workforce-level work",
      remove_goals_silently: "goal removal requires evidence and a recorded transition",
      reduce_verification: "verification requirements cannot be reduced mid-run",
      disable_memory_safety: "secret redaction cannot be disabled",
      bypass_permissions: "permission boundaries are enforced by the host",
      declare_complete_without_evidence: "completion requires the evidence chain",
    };
    if (action in forbidden) return { allowed: false, reason: forbidden[action] };
    return { allowed: true };
  }

  status(): CortexStatusView {
    const st = this.store.load();
    const goals = this.store.loadGoals();
    const decision = this.lastDecision;
    const nextMap: Record<CortexState, string> = {
      IDLE: "start → UNDERSTANDING",
      UNDERSTANDING: "retrieveMemory",
      MEMORY_RETRIEVAL: "discover capabilities",
      CAPABILITY_DISCOVERY: "formGoals",
      GOAL_FORMATION: "planWorkforce",
      WORKFORCE_PLANNING: "dispatch",
      DISPATCHING: "collect reports",
      EXECUTING: "rehearse",
      REHEARSAL: "beginImplementation",
      IMPLEMENTATION: "runGauntlet",
      GAUNTLET: this.lastGauntlet?.passed ? "verify" : "remediate",
      REMEDIATION: "re-plan → implement → runGauntlet",
      VERIFICATION: this.lastVerdict?.complete ? "learn → finish" : "remediate / re-plan",
      LEARNING: "finish",
      COMPLETED: "done",
      BLOCKED: "inspect → re-plan or fail",
      FAILED: "terminal",
      PAUSED: "resume",
    };
    const icon = (s: string) => (s === "verified" ? "✓" : s === "failed" || s === "blocked" ? "✗" : "◌");
    void resolveModelTier;
    return {
      objective: st?.objective ?? "(no active run)",
      phase: st?.state ?? "IDLE",
      goals: goals.map((g) => ({ id: `${icon(g.status)} ${g.id}`, description: g.description, status: g.status, verification: g.verificationState })),
      workers: (decision?.goalsAssigned ?? []).map((a, i) => ({ id: `W${i + 1}-${a.workerRole}`, role: a.workerRole, goals: a.goalIds })),
      concurrency: decision ? `${decision.concurrency} / ${this.config.limits.maxConcurrentWorkers}` : `1 / ${this.config.limits.maxConcurrentWorkers}`,
      next: st ? nextMap[st.state] : "start",
      budget: `${this.budgets.pressure()} (tokens≈${this.budgets.usage.estimatedTokens}/${this.config.limits.maxTokensEstimated})`,
      escalation: `level ${st?.escalationLevel ?? 0}`,
    };
  }

  inspect(): { state: ReturnType<StateStore["load"]>; goals: Goal[]; decision: WorkforceDecision | null; gauntlet: GauntletResult | null; verdict: CompletionVerdict | null } {
    return {
      state: this.store.load(),
      goals: this.store.loadGoals(),
      decision: this.lastDecision,
      gauntlet: this.lastGauntlet,
      verdict: this.lastVerdict,
    };
  }

  searchMemory(query: string): MemoryEntry[] {
    return this.memory.recall(query, this.projectId, this.config.memory.retrievalBudgetChars);
  }

  clearProjectMemory(): number {
    return this.memory.clearProject(this.projectId);
  }

  private requireState(...allowed: CortexState[]): void {
    const st = this.store.load();
    if (!st) throw new Error("cortex: no active run — call start() first");
    if (!allowed.includes(st.state)) {
      throw new Error(`cortex: stage requires ${allowed.join("/")} but run is ${st.state}`);
    }
  }

  private writeEvidence(name: string, data: unknown): void {
    const dir = evidenceDir(this.projectRoot);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    if (existsSync(p)) {
      // Never silently overwrite evidence — version it.
      writeFileSync(join(dir, `${Date.now()}-${name}`), JSON.stringify(data, null, 2));
    } else {
      writeFileSync(p, JSON.stringify(data, null, 2));
    }
  }

  readEvidence(name: string): unknown {
    const p = join(evidenceDir(this.projectRoot), name);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
}
