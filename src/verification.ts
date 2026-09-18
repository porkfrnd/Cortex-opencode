import type { CompletionVerdict, GauntletResult, Goal } from "./types.js";

/**
 * Evidence-based completion (§18): OBJECTIVE -> GOALS -> SUCCESS CRITERIA ->
 * EVIDENCE -> GAUNTLET -> VERIFICATION -> DONE. Never a vibe.
 */
export function verifyCompletion(goals: Goal[], gauntlet: GauntletResult | null): CompletionVerdict {
  const perGoal = goals.map((g) => ({
    goalId: g.id,
    status: g.status,
    verification: g.verificationState,
    evidenceCount: g.evidence.length,
  }));

  const uncertainGoals = goals
    .filter((g) => g.status === "uncertain" || (g.evidence.length === 0 && g.status !== "abandoned" && g.status !== "verified"))
    .map((g) => g.id);

  const blockingFindings = (gauntlet?.findings ?? [])
    .filter((f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"))
    .map((f) => f.id);

  const activeGoals = goals.filter((g) => g.status !== "abandoned");
  const allVerified = activeGoals.length > 0 && activeGoals.every((g) => g.status === "verified" && g.verificationState === "passed");
  const objectiveMet = allVerified && blockingFindings.length === 0 && gauntlet !== null && gauntlet.passed;

  const summary = objectiveMet
    ? `COMPLETE: ${activeGoals.length} goals verified with evidence; gauntlet round ${gauntlet?.round} clean.`
    : `INCOMPLETE: verified=${activeGoals.filter((g) => g.status === "verified").length}/${activeGoals.length}, ` +
      `uncertain=[${uncertainGoals.join(",")}], blocking=[${blockingFindings.join(",")}]`;

  return { complete: objectiveMet, objectiveMet, perGoal, uncertainGoals, blockingFindings, summary };
}

/** Mark goals verified only when evidence + gauntlet both agree. */
export function applyGauntletVerdicts(goals: Goal[], gauntlet: GauntletResult): Goal[] {
  const verdict = new Map(gauntlet.goalVerdicts.map((v) => [v.goalId, v.passed]));
  return goals.map((g) => {
    if (g.status === "abandoned") return g;
    const passed = verdict.get(g.id);
    const hasEvidence = g.evidence.length > 0;
    if (passed === true && hasEvidence && (g.status === "in_review" || g.status === "in_progress" || g.status === "assigned")) {
      return { ...g, status: "verified" as const, verificationState: "passed" as const, updatedAt: new Date().toISOString() };
    }
    if (passed === false) {
      return { ...g, status: "blocked" as const, verificationState: "failed" as const, updatedAt: new Date().toISOString() };
    }
    if (!hasEvidence && (g.status === "in_review" || g.status === "in_progress")) {
      return { ...g, status: "uncertain" as const, verificationState: "uncertain" as const, updatedAt: new Date().toISOString() };
    }
    return g;
  });
}
