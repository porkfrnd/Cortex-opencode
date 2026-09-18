import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CortexState, Goal, StateTransition } from "./types.js";
import { cortexRoot, goalsPath, statePath, transitionsPath } from "./paths.js";

/** Deterministic transition table — the model may propose, the controller disposes. */
const ALLOWED: Record<CortexState, CortexState[]> = {
  IDLE: ["UNDERSTANDING", "PAUSED"],
  UNDERSTANDING: ["MEMORY_RETRIEVAL", "BLOCKED", "FAILED", "PAUSED"],
  MEMORY_RETRIEVAL: ["CAPABILITY_DISCOVERY", "BLOCKED", "FAILED", "PAUSED"],
  CAPABILITY_DISCOVERY: ["GOAL_FORMATION", "BLOCKED", "FAILED", "PAUSED"],
  GOAL_FORMATION: ["WORKFORCE_PLANNING", "BLOCKED", "FAILED", "PAUSED"],
  WORKFORCE_PLANNING: ["DISPATCHING", "IMPLEMENTATION", "BLOCKED", "FAILED", "PAUSED"],
  DISPATCHING: ["EXECUTING", "IMPLEMENTATION", "BLOCKED", "FAILED", "PAUSED"],
  EXECUTING: ["REHEARSAL", "IMPLEMENTATION", "BLOCKED", "FAILED", "PAUSED"],
  REHEARSAL: ["IMPLEMENTATION", "WORKFORCE_PLANNING", "BLOCKED", "FAILED", "PAUSED"],
  IMPLEMENTATION: ["GAUNTLET", "BLOCKED", "FAILED", "PAUSED"],
  GAUNTLET: ["REMEDIATION", "VERIFICATION", "BLOCKED", "FAILED", "PAUSED"],
  REMEDIATION: ["GAUNTLET", "VERIFICATION", "WORKFORCE_PLANNING", "BLOCKED", "FAILED", "PAUSED"],
  VERIFICATION: ["LEARNING", "REMEDIATION", "WORKFORCE_PLANNING", "BLOCKED", "FAILED", "PAUSED"],
  LEARNING: ["COMPLETED", "BLOCKED", "WORKFORCE_PLANNING", "FAILED", "PAUSED"],
  COMPLETED: [],
  BLOCKED: ["WORKFORCE_PLANNING", "GOAL_FORMATION", "FAILED", "PAUSED", "IDLE"],
  FAILED: ["IDLE"],
  PAUSED: ["IDLE", "UNDERSTANDING", "WORKFORCE_PLANNING", "DISPATCHING", "EXECUTING", "REHEARSAL", "IMPLEMENTATION", "GAUNTLET", "REMEDIATION", "VERIFICATION", "LEARNING"],
};

export interface RunState {
  runId: string;
  objective: string;
  state: CortexState;
  retries: number;
  maxRetries: number;
  escalationLevel: number;
  updatedAt: string;
  createdAt: string;
  note?: string;
}

/** Model proposals the controller will reject without evidence. */
const FORBIDDEN_MODEL_ACTIONS = [
  "mark_unverified_goal_complete",
  "bypass_resource_limits",
  "bypass_gauntlet",
  "remove_goals_silently",
  "reduce_verification",
  "disable_memory_safety",
  "bypass_permissions",
  "declare_complete_without_evidence",
] as const;

export type ForbiddenAction = (typeof FORBIDDEN_MODEL_ACTIONS)[number];

export function isForbiddenAction(action: string): action is ForbiddenAction {
  return (FORBIDDEN_MODEL_ACTIONS as readonly string[]).includes(action);
}

export class StateStore {
  constructor(private projectRoot: string) {}

  private ensureDirs(): void {
    mkdirSync(dirname(statePath(this.projectRoot)), { recursive: true });
    mkdirSync(dirname(goalsPath(this.projectRoot)), { recursive: true });
  }

  load(): RunState | null {
    const p = statePath(this.projectRoot);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as RunState;
    } catch {
      return null;
    }
  }

  save(state: RunState): void {
    this.ensureDirs();
    writeFileSync(statePath(this.projectRoot), JSON.stringify(state, null, 2));
  }

  init(objective: string, runId: string): RunState {
    const now = new Date().toISOString();
    const s: RunState = {
      runId,
      objective,
      state: "IDLE",
      retries: 0,
      maxRetries: 3,
      escalationLevel: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.save(s);
    return s;
  }

  /**
   * The single choke point for every state change. Throws on illegal
   * transitions — the model cannot talk itself past this.
   */
  transition(to: CortexState, event: string, evidenceRef?: string): RunState {
    const cur = this.load();
    if (!cur) throw new Error("cortex: no active run — call init first");
    const allowed = ALLOWED[cur.state] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(
        `cortex: illegal transition ${cur.state} -> ${to} (event: ${event}). Allowed: ${allowed.join(", ") || "none"}`
      );
    }
    const next: RunState = {
      ...cur,
      state: to,
      retries: to === cur.state ? cur.retries : 0,
      updatedAt: new Date().toISOString(),
    };
    this.save(next);
    this.recordTransition({ from: cur.state, to, event, evidenceRef, retries: next.retries, at: next.updatedAt });
    return next;
  }

  recordRetry(note: string): RunState {
    const cur = this.load();
    if (!cur) throw new Error("cortex: no active run");
    if (cur.retries + 1 > cur.maxRetries) {
      return this.transition("BLOCKED", `retry budget exhausted: ${note}`);
    }
    const next: RunState = { ...cur, retries: cur.retries + 1, updatedAt: new Date().toISOString(), note };
    this.save(next);
    this.recordTransition({ from: cur.state, to: cur.state, event: `retry:${note}`, retries: next.retries, at: next.updatedAt });
    return next;
  }

  private recordTransition(t: StateTransition): void {
    this.ensureDirs();
    appendFileSync(transitionsPath(this.projectRoot), JSON.stringify(t) + "\n");
  }

  readTransitions(): StateTransition[] {
    const p = transitionsPath(this.projectRoot);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StateTransition);
  }

  loadGoals(): Goal[] {
    const p = goalsPath(this.projectRoot);
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Goal[];
    } catch {
      return [];
    }
  }

  saveGoals(goals: Goal[]): void {
    this.ensureDirs();
    writeFileSync(goalsPath(this.projectRoot), JSON.stringify(goals, null, 2));
  }

  cortexDir(): string {
    return cortexRoot(this.projectRoot);
  }
}
