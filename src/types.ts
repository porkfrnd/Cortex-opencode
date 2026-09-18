/**
 * Shared Cortex types. The controller (controller.ts) is the only authority
 * that may transition execution state or declare completion.
 */

export type CortexState =
  | "IDLE"
  | "UNDERSTANDING"
  | "MEMORY_RETRIEVAL"
  | "CAPABILITY_DISCOVERY"
  | "GOAL_FORMATION"
  | "WORKFORCE_PLANNING"
  | "DISPATCHING"
  | "EXECUTING"
  | "REHEARSAL"
  | "IMPLEMENTATION"
  | "GAUNTLET"
  | "REMEDIATION"
  | "VERIFICATION"
  | "LEARNING"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "PAUSED";

export type GoalStatus =
  | "proposed"
  | "ready"
  | "assigned"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "verified"
  | "failed"
  | "uncertain"
  | "abandoned";

export interface Goal {
  id: string;
  description: string;
  successCriteria: string[];
  priority: number; // 1 (highest) .. 5
  dependencies: string[];
  status: GoalStatus;
  requiredCapabilities: string[];
  assignedWorkers: string[];
  evidence: Evidence[];
  verificationState: "unverified" | "passed" | "failed" | "uncertain";
  origin: "initial" | "adaptive" | "remediation";
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  kind:
    | "test_result"
    | "build_result"
    | "file_artifact"
    | "api_behavior"
    | "browser_observation"
    | "requirement_mapping"
    | "finding_resolution"
    | "note";
  summary: string;
  ref?: string;
  passed: boolean;
  at: string;
}

export type WorkerRole =
  | "researcher"
  | "architect"
  | "frontend_engineer"
  | "backend_engineer"
  | "database_engineer"
  | "debugger"
  | "tester"
  | "security_reviewer"
  | "ux_reviewer"
  | "performance_analyst"
  | "documentation_engineer"
  | "devops_engineer"
  | "code_reviewer"
  | "lead";

export interface WorkerBrief {
  workerId: string;
  role: WorkerRole;
  goalIds: string[];
  skills: string[];
  tools: string[];
  constraints: string[];
  modelTier: "cheap" | "strong";
  budgetChars: number;
  createdAt: string;
}

export interface WorkerReport {
  workerId: string;
  goalId: string;
  findings: string[];
  evidence: Evidence[];
  openQuestions: string[];
  confidence: number; // 0..1
  diffSummary: string;
  logs: string;
  alternativeApproaches: string[];
  risks: string[];
  at: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface GauntletFinding {
  id: string;
  goalId: string;
  title: string;
  evidence: string;
  severity: Severity;
  requiredRemediation: string;
  category: string;
  status: "open" | "remediating" | "resolved" | "waived";
  at: string;
}

export interface GauntletResult {
  passed: boolean;
  goalVerdicts: Array<{ goalId: string; passed: boolean }>;
  findings: GauntletFinding[];
  round: number;
  at: string;
}

export interface WorkforceDecision {
  requiredWorkers: number;
  concurrency: number;
  rationale: string;
  goalsAssigned: Array<{ workerRole: WorkerRole; goalIds: string[]; modelTier: "cheap" | "strong" }>;
  executableGoals: string[];
  deferredGoals: string[];
  at: string;
}

export interface StateTransition {
  from: CortexState;
  to: CortexState;
  event: string;
  evidenceRef?: string;
  retries: number;
  at: string;
}

export interface MemoryEntry {
  id: string;
  projectId: string | "global";
  kind:
    | "fact"
    | "decision"
    | "technical_discovery"
    | "failed_approach"
    | "constraint"
    | "pattern"
    | "quirk";
  text: string;
  importance: number; // 0..1
  usefulness: number; // running score from outcomes
  uses: number;
  hits: number;
  provenance: string;
  createdAt: string;
  updatedAt: string;
}

export interface Capability {
  kind: "skill" | "tool" | "plugin" | "mcp" | "agent" | "command" | "runtime";
  name: string;
  description: string;
  source: string;
}

export interface ResourceUsage {
  workerCount: number;
  activeWorkers: number;
  modelCalls: number;
  goalCount: number;
  dynamicGoals: number;
  gauntletPasses: number;
  remediationRounds: number;
  startedAt: string;
  elapsedMs: number;
  estimatedTokens: number;
}

export interface CortexLimits {
  maxGoalDepth: number;
  maxDynamicGoals: number;
  maxTaskBudget: number;
  maxWorkers: number;
  maxConcurrentWorkers: number;
  maxGauntletRounds: number;
  maxRemediationRounds: number;
  maxContextChars: number;
  maxTokensEstimated: number;
  maxExecutionMs: number;
}

export interface CompletionVerdict {
  complete: boolean;
  objectiveMet: boolean;
  perGoal: Array<{
    goalId: string;
    status: GoalStatus;
    verification: Goal["verificationState"];
    evidenceCount: number;
  }>;
  uncertainGoals: string[];
  blockingFindings: string[];
  summary: string;
}
