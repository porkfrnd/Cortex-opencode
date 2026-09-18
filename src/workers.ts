import type { Evidence, Goal, WorkerBrief, WorkerReport, WorkerRole } from "./types.js";
import { busRead, busWrite } from "./bus.js";

/** Enforced ceilings for worker report inputs to rehearsal (§13). */
export const REPORT_BUDGETS = {
  maxDiffSummaryChars: 4000,
  maxLogsChars: 4000,
  maxFindings: 20,
  maxEvidence: 15,
  maxBriefChars: 6000,
};

let workerSeq = 0;

export function buildBrief(input: {
  role: WorkerRole;
  goalIds: string[];
  goals: Goal[];
  skills: string[];
  tools: string[];
  constraints: string[];
  modelTier: "cheap" | "strong";
}): WorkerBrief {
  const brief: WorkerBrief = {
    workerId: `W${++workerSeq}-${input.role}`,
    role: input.role,
    goalIds: input.goalIds,
    skills: input.skills,
    tools: input.tools,
    constraints: input.constraints,
    modelTier: input.modelTier,
    budgetChars: REPORT_BUDGETS.maxBriefChars,
    createdAt: new Date().toISOString(),
  };
  return brief;
}

export function renderBriefText(brief: WorkerBrief, goals: Goal[]): string {
  const lines: string[] = [
    `ROLE\n  ${brief.role}`,
    ``,
    `WORKER\n  ${brief.workerId} (model tier: ${brief.modelTier})`,
    ``,
    `GOALS`,
  ];
  for (const id of brief.goalIds) {
    const g = goals.find((x) => x.id === id);
    if (!g) continue;
    lines.push(`  ${g.id}: ${g.description}`);
    for (const c of g.successCriteria) lines.push(`    - success: ${c}`);
  }
  lines.push(``, `SKILLS\n  ${brief.skills.join(", ") || "(none)"}`);
  lines.push(``, `TOOLS\n  ${brief.tools.join(", ") || "(none)"}`);
  lines.push(``, `CONSTRAINTS`);
  for (const c of brief.constraints) lines.push(`  - ${c}`);
  lines.push(
    ``,
    `PROTOCOL`,
    `  1. inspect relevant context and files (scope to your goal only)`,
    `  2. use assigned tools and skills per their instructions`,
    `  3. investigate, implement or analyze; test where appropriate`,
    `  4. report via the structured report schema — findings, evidence, open questions, confidence`,
    `  5. flag uncertainty and unresolved issues; never contact the user for repo-discoverable facts`,
    `  6. keep diffSummary <= ${REPORT_BUDGETS.maxDiffSummaryChars} chars, logs <= ${REPORT_BUDGETS.maxLogsChars} chars`,
  );
  const text = lines.join("\n");
  return text.length > brief.budgetChars ? text.slice(0, brief.budgetChars) : text;
}

/** Enforce the rehearsal input budget at the producer side (§13). */
export function normalizeReport(raw: WorkerReport): WorkerReport {
  return {
    ...raw,
    findings: raw.findings.slice(0, REPORT_BUDGETS.maxFindings),
    evidence: raw.evidence.slice(0, REPORT_BUDGETS.maxEvidence),
    diffSummary: raw.diffSummary.slice(0, REPORT_BUDGETS.maxDiffSummaryChars),
    logs: raw.logs.slice(0, REPORT_BUDGETS.maxLogsChars),
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    at: raw.at || new Date().toISOString(),
  };
}

export function dispatchBriefs(
  projectRoot: string,
  briefs: Array<{ brief: WorkerBrief; text: string }>
): void {
  for (const { brief, text } of briefs) {
    busWrite(projectRoot, { kind: "dispatch", from: "controller", to: brief.workerId, payload: { brief, text } });
  }
}

export function collectReports(projectRoot: string, _workerIds: string[], since: string): WorkerReport[] {
  return busRead(projectRoot, { kind: "report", since })
    .map((m) => m.payload as WorkerReport)
    .map(normalizeReport);
}

export function emptyReport(workerId: string, goalId: string, note: string): WorkerReport {
  const ev: Evidence = { kind: "note", summary: note, passed: false, at: new Date().toISOString() };
  return {
    workerId,
    goalId,
    findings: [note],
    evidence: [ev],
    openQuestions: [note],
    confidence: 0,
    diffSummary: "",
    logs: "",
    alternativeApproaches: [],
    risks: ["worker produced no usable output"],
    at: new Date().toISOString(),
  };
}
