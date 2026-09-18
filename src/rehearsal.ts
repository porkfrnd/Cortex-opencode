import type { WorkerReport } from "./types.js";

export interface RehearsalSynthesis {
  workersConsulted: number;
  agreement: string[];
  disagreement: string[];
  conflictingAssumptions: string[];
  evidenceStrength: string;
  alternatives: string[];
  risks: string[];
  gaps: string[];
  duplicates: string[];
  selectedApproach: string;
  rejectedApproaches: string[];
  verificationNeeds: string[];
  at: string;
}

function overlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

/**
 * Lead synthesis pass (§13). Deterministic comparison of structured reports;
 * the lead (model) owns the final call, but agreement/disagreement/evidence
 * accounting is computed, not vibe-checked.
 */
export function synthesize(reports: WorkerReport[]): RehearsalSynthesis {
  const all = reports.map((r) => r.findings.join(" | "));
  const agreement: string[] = [];
  const disagreement: string[] = [];

  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const sim = overlap(all[i], all[j]);
      if (sim >= 0.35) agreement.push(`${reports[i].workerId} ~ ${reports[j].workerId} agree (similarity ${sim.toFixed(2)})`);
      else if (sim < 0.12 && all[i] && all[j]) disagreement.push(`${reports[i].workerId} vs ${reports[j].workerId} diverge (similarity ${sim.toFixed(2)})`);
    }
  }

  const uncertain = reports.filter((r) => r.confidence < 0.5).map((r) => `${r.workerId} low confidence (${r.confidence})`);
  const evidenced = reports.filter((r) => r.evidence.some((e) => e.passed)).length;
  const alternatives = [...new Set(reports.flatMap((r) => r.alternativeApproaches))];
  const risks = [...new Set(reports.flatMap((r) => r.risks))];
  const gaps = [...new Set(reports.flatMap((r) => r.openQuestions))];

  // Selected approach: highest-confidence report with passing evidence wins;
  // ties broken by evidence count. Fully deterministic.
  const ranked = [...reports].sort((a, b) => {
    const ae = a.evidence.filter((e) => e.passed).length;
    const be = b.evidence.filter((e) => e.passed).length;
    return b.confidence - a.confidence || be - ae;
  });
  const winner = ranked[0];

  return {
    workersConsulted: reports.length,
    agreement,
    disagreement,
    conflictingAssumptions: uncertain,
    evidenceStrength: `${evidenced}/${reports.length} reports carry passing evidence`,
    alternatives,
    risks,
    gaps,
    duplicates: disagreement.length === 0 && reports.length > 1 ? ["reports overlap heavily — possible duplicated work"] : [],
    selectedApproach: winner
      ? `${winner.workerId} approach for ${winner.goalId}: ${winner.findings[0] ?? "no findings"}`
      : "no reports — lead proceeds from goal criteria directly",
    rejectedApproaches: ranked.slice(1).map((r) => `${r.workerId}: ${r.findings[0] ?? "no findings"}`),
    verificationNeeds: gaps.map((g) => `verify: ${g}`),
    at: new Date().toISOString(),
  };
}
