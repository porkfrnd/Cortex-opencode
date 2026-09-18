import type { CortexLimits, Goal, WorkforceDecision, WorkerRole } from "./types.js";
import { classifyObjective, executableGoals } from "./goals.js";

export interface SchedulerInput {
  objective: string;
  goals: Goal[];
  limits: CortexLimits;
  /** Remaining execution budget in ms. */
  remainingMs: number;
  /** Rough model-call spend so far (for downgrade pressure). */
  modelCalls: number;
  availableModelCapacity: number;
}

function complexityOf(goal: Goal, touchesUI: boolean): number {
  let c = 1;
  c += Math.min(goal.successCriteria.length, 4) * 0.5;
  c += Math.min(goal.requiredCapabilities.length, 5) * 0.3;
  if (goal.priority <= 1) c += 0.5;
  if (touchesUI && /responsive|accessib|visual/i.test(goal.description)) c += 0.5;
  if (goal.origin !== "initial") c += 0.3;
  return c;
}

function roleFor(goal: Goal): WorkerRole {
  const d = goal.description.toLowerCase();
  if (/\b(responsive|visual|ux|accessib|css|layout|design)\b/.test(d)) return "ux_reviewer";
  if (/\b(frontend|react|vue|component|page|ui)\b/.test(d)) return "frontend_engineer";
  if (/\b(auth|secret|permission|secur)\b/.test(d)) return "security_reviewer";
  if (/\b(database|sql|schema|migration|prisma)\b/.test(d)) return "database_engineer";
  if (/\b(bug|fix|crash|overflow|regress|debug|fail)\b/.test(d)) return "debugger";
  if (/\b(test|coverage|suite)\b/.test(d)) return "tester";
  if (/\b(performance|latency|slow|profil)\b/.test(d)) return "performance_analyst";
  if (/\b(api|contract|endpoint|backend|server)\b/.test(d)) return "backend_engineer";
  if (/\b(doc|readme|guide)\b/.test(d)) return "documentation_engineer";
  if (/\b(deploy|ci|docker|infra)\b/.test(d)) return "devops_engineer";
  if (/\b(architect|scope|plan|research|investigat)\b/.test(d)) return "researcher";
  return "backend_engineer";
}

/**
 * The real workforce decision function (§9). Pure, inspectable, enforced by
 * the scheduler — never a hard-coded count, never "one worker per goal".
 *
 * Weighs: executable goal count, dependency parallelism, goal complexity,
 * specialization spread, model capacity, configured limits, remaining budget,
 * and diminishing returns.
 */
export function decideWorkforce(input: SchedulerInput): WorkforceDecision {
  const sig = classifyObjective(input.objective);
  const exec = executableGoals(input.goals);
  const at = new Date().toISOString();

  const triviallySmall =
    sig.isTrivial && exec.length <= 1;

  if (exec.length === 0 || triviallySmall) {
    return {
      requiredWorkers: 0,
      concurrency: 1,
      rationale: triviallySmall
        ? "trivial objective: lead handles directly, zero workers"
        : "no executable goals right now (dependencies unmet or all terminal): zero workers",
      goalsAssigned: [],
      executableGoals: exec.map((g) => g.id),
      deferredGoals: input.goals.filter((g) => !exec.includes(g)).map((g) => g.id),
      at,
    };
  }

  // Expected benefit per executable goal (complexity = parallelism payoff).
  const scored = exec.map((g) => ({ goal: g, complexity: complexityOf(g, sig.touchesUI) }));
  const totalComplexity = scored.reduce((a, s) => a + s.complexity, 0);

  // Diminishing returns: marginal benefit of the k-th worker decays.
  // benefit(k) ~= totalComplexity * (1 - e^-k / C) ... discretized below.
  let workers = 0;
  let marginal = totalComplexity;
  const DECAY = 0.55;
  const MIN_MARGINAL = 0.9; // below this, another worker is theatre
  while (marginal > MIN_MARGINAL && workers < exec.length && workers < input.limits.maxWorkers) {
    workers++;
    marginal *= DECAY;
    // Budget pressure: halve appetite when remaining budget is thin.
    if (input.remainingMs < 5 * 60 * 1000) marginal *= 0.7;
    if (input.modelCalls > 40) marginal *= 0.85;
  }
  workers = Math.max(1, Math.min(workers, input.limits.maxWorkers, input.availableModelCapacity, exec.length));

  // Specialization: goals needing distinct roles justify distinct workers.
  const roles = new Set(scored.map((s) => roleFor(s.goal)));
  workers = Math.min(workers, Math.max(roles.size, 1));
  // Never exceed task budget headroom.
  if (input.modelCalls >= input.limits.maxTaskBudget) workers = 0;

  if (workers === 0) {
    return {
      requiredWorkers: 0,
      concurrency: 1,
      rationale: "budget exhausted: task budget headroom is zero, lead proceeds alone or blocks",
      goalsAssigned: [],
      executableGoals: exec.map((g) => g.id),
      deferredGoals: [],
      at,
    };
  }

  // Assign highest-complexity goals first, spreading roles.
  const ordered = [...scored].sort((a, b) => b.complexity - a.complexity);
  const assignments: WorkforceDecision["goalsAssigned"] = [];
  for (let i = 0; i < workers; i++) {
    const s = ordered[i % ordered.length];
    const role = roleFor(s.goal);
    const existing = assignments.find((a) => a.workerRole === role);
    if (existing && i >= ordered.length) {
      existing.goalIds.push(s.goal.id);
    } else {
      assignments.push({
        workerRole: role,
        goalIds: [s.goal.id],
        modelTier: s.complexity >= 2.5 || role === "architect" ? "strong" : "cheap",
      });
    }
  }

  // Concurrency (§10): independent goals run together; cap by limit + capacity.
  const concurrency = Math.max(
    1,
    Math.min(assignments.length, input.limits.maxConcurrentWorkers, input.availableModelCapacity)
  );

  const rationale =
    `executable=${exec.length} complexity=${totalComplexity.toFixed(1)} roles=${roles.size} ` +
    `workers=${workers} concurrency=${concurrency} (limits: maxWorkers=${input.limits.maxWorkers}, ` +
    `maxConcurrent=${input.limits.maxConcurrentWorkers}, remainingMs=${input.remainingMs})`;

  return {
    requiredWorkers: workers,
    concurrency,
    rationale,
    goalsAssigned: assignments,
    executableGoals: exec.map((g) => g.id),
    deferredGoals: input.goals.filter((g) => !exec.includes(g)).map((g) => g.id),
    at,
  };
}

/** Re-evaluate concurrency as the graph evolves (§10). */
export function currentConcurrency(
  goals: Goal[],
  decision: WorkforceDecision,
  limits: CortexLimits
): number {
  const runnable = executableGoals(goals).filter((g) => g.status !== "verified" && g.status !== "failed").length;
  return Math.max(1, Math.min(runnable, decision.requiredWorkers, limits.maxConcurrentWorkers));
}
