import type { CortexLimits, ResourceUsage } from "./types.js";

/** Live budget tracking (§26): downgrade BEFORE blowing through ceilings. */
export class BudgetTracker {
  usage: ResourceUsage;

  constructor(
    private limits: CortexLimits,
    runStartedAt?: string
  ) {
    const now = new Date().toISOString();
    this.usage = {
      workerCount: 0,
      activeWorkers: 0,
      modelCalls: 0,
      goalCount: 0,
      dynamicGoals: 0,
      gauntletPasses: 0,
      remediationRounds: 0,
      startedAt: runStartedAt ?? now,
      elapsedMs: 0,
      estimatedTokens: 0,
    };
  }

  touch(): void {
    this.usage.elapsedMs = Date.now() - Date.parse(this.usage.startedAt);
  }

  addModelCalls(n: number, estimatedTokens = 0): void {
    this.usage.modelCalls += n;
    this.usage.estimatedTokens += estimatedTokens || n * 1500;
    this.touch();
  }

  pressure(): "ok" | "tight" | "critical" {
    this.touch();
    const tokenRatio = this.usage.estimatedTokens / Math.max(1, this.limits.maxTokensEstimated);
    const timeRatio = this.usage.elapsedMs / Math.max(1, this.limits.maxExecutionMs);
    const taskRatio = this.usage.modelCalls / Math.max(1, this.limits.maxTaskBudget);
    const worst = Math.max(tokenRatio, timeRatio, taskRatio);
    if (worst >= 0.9) return "critical";
    if (worst >= 0.65) return "tight";
    return "ok";
  }

  /** Downgrade knobs the scheduler applies as spend approaches ceilings. */
  downgrade(): { maxWorkers: number; maxConcurrent: number; shortGauntlet: boolean } {
    const p = this.pressure();
    if (p === "critical") {
      return {
        maxWorkers: Math.min(1, this.limits.maxWorkers),
        maxConcurrent: 1,
        shortGauntlet: true,
      };
    }
    if (p === "tight") {
      return {
        maxWorkers: Math.max(1, Math.floor(this.limits.maxWorkers / 2)),
        maxConcurrent: Math.max(1, Math.floor(this.limits.maxConcurrentWorkers / 2)),
        shortGauntlet: true,
      };
    }
    return { maxWorkers: this.limits.maxWorkers, maxConcurrent: this.limits.maxConcurrentWorkers, shortGauntlet: false };
  }

  checkHardCeilings(): string | null {
    this.touch();
    if (this.usage.elapsedMs > this.limits.maxExecutionMs) return "execution time ceiling exceeded";
    if (this.usage.estimatedTokens > this.limits.maxTokensEstimated) return "token budget ceiling exceeded";
    if (this.usage.modelCalls > this.limits.maxTaskBudget) return "task budget ceiling exceeded";
    if (this.usage.dynamicGoals > this.limits.maxDynamicGoals) return "dynamic goal ceiling exceeded";
    if (this.usage.remediationRounds > this.limits.maxRemediationRounds) return "remediation round ceiling exceeded";
    if (this.usage.gauntletPasses > this.limits.maxGauntletRounds) return "gauntlet round ceiling exceeded";
    return null;
  }
}

/**
 * Model routing (§25): capability-based tier selection. Provider-agnostic —
 * resolves preference hints against actually configured availability.
 */
export function resolveModelTier(
  task: "classification" | "memory" | "summarization" | "status" | "architecture" | "synthesis" | "implementation" | "gauntlet",
  cheap: string[],
  strong: string[]
): string {
  const cheapTasks = new Set(["classification", "memory", "summarization", "status"]);
  const pool = cheapTasks.has(task) ? cheap : strong;
  return pool[0] ?? "default";
}
