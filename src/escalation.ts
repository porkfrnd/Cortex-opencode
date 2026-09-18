import { classifyObjective } from "./goals.js";

/**
 * Escalation ladder (§35). Cortex starts as low as the objective allows and
 * climbs only when evidence says the current level isn't enough. Escalation
 * only ever ADDS rigor — it never removes verification.
 */
export type EscalationLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const LEVEL_NAMES: Record<EscalationLevel, string> = {
  0: "Direct execution",
  1: "Lead + lightweight planning",
  2: "Lead + one specialist",
  3: "Small parallel workforce",
  4: "Full workforce + rehearsal + Gauntlet",
  5: "Multi-round remediation and re-planning",
};

export function initialLevel(objective: string): EscalationLevel {
  const s = classifyObjective(objective);
  if (s.isTrivial) return 0;
  const words = objective.trim().split(/\s+/).length;
  const o = objective.toLowerCase();
  if (s.isMigration || s.touchesAuth || (s.touchesUI && s.touchesAPI)) return 4;
  // Compound objectives ("X and Y", production-readiness) need a workforce
  // from the start — a lead alone cannot parallelize genuinely split work.
  if (/\bproduction[- ]ready\b/.test(o)) return 3;
  if (/\band\b/.test(o) && words >= 8) return 2;
  if (words <= 12) return 1;
  if (words <= 30) return 2;
  return 3;
}

export function shouldEscalate(input: {
  level: EscalationLevel;
  gauntletFailed: boolean;
  hasBlockingFindings: boolean;
  hasUnresolvedGoals: boolean;
}): boolean {
  if (input.level >= 5) return false;
  return input.gauntletFailed || input.hasBlockingFindings || input.hasUnresolvedGoals;
}

export function levelUsesWorkforce(level: EscalationLevel): boolean {
  return level >= 2;
}

export function levelUsesGauntlet(level: EscalationLevel): boolean {
  // A Level 5 objective still gets the full Gauntlet; low levels on trivial
  // tasks skip it, but escalation re-adds it — never the reverse.
  return level >= 3;
}

export function describeLevel(level: EscalationLevel): string {
  return `LEVEL ${level} — ${LEVEL_NAMES[level]}`;
}
