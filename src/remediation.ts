import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GauntletFinding, Goal, WorkerRole } from "./types.js";

export interface RemediationPlan {
  findingId: string;
  goalId: string;
  role: WorkerRole;
  instruction: string;
  dependsOn: string[];
  parallelGroup: number;
}

/** finding -> required capability -> right worker -> verify (§17). */
export function planRemediation(findings: GauntletFinding[], goals: Goal[]): RemediationPlan[] {
  const open = findings.filter((f) => f.status === "open");
  const plans: RemediationPlan[] = open.map((f) => ({
    findingId: f.id,
    goalId: f.goalId,
    role: roleForCategory(f.category),
    instruction: `${f.title}. Evidence: ${f.evidence}. Required: ${f.requiredRemediation}`,
    dependsOn: [],
    parallelGroup: 0,
  }));

  // Dependent fixes serialize: findings on the same goal with overlapping
  // categories chain; independent findings run in parallel groups.
  const byGoal = new Map<string, RemediationPlan[]>();
  for (const p of plans) {
    const l = byGoal.get(p.goalId) ?? [];
    l.push(p);
    byGoal.set(p.goalId, l);
  }
  let group = 0;
  for (const [, list] of byGoal) {
    list.forEach((p, i) => {
      p.parallelGroup = group;
      if (i > 0) p.dependsOn = [list[i - 1].findingId];
    });
    group++;
  }
  void goals;
  return plans;
}

function roleForCategory(category: string): WorkerRole {
  switch (category) {
    case "accessibility":
    case "responsiveness":
    case "ux-genericness":
      return "ux_reviewer";
    case "security":
      return "security_reviewer";
    case "tests":
      return "tester";
    case "requirements":
    case "evidence":
      return "architect";
    case "regressions":
      return "debugger";
    default:
      return "debugger";
  }
}

/**
 * Stuck-cycle guard (§16): hash the state of every file touched by a
 * remediation pass; if the same file-set hash recurs within the last three
 * rounds, halt as a stuck cycle instead of oscillating forever.
 */
export class CycleGuard {
  private history: string[] = [];

  fingerprint(files: string[], projectRoot: string): string {
    const h = createHash("sha256");
    for (const f of [...files].sort()) {
      try {
        const content = readFileSync(resolve(projectRoot, f));
        h.update(f);
        h.update(createHash("sha256").update(content).digest("hex"));
      } catch {
        h.update(f);
        h.update("missing");
      }
    }
    return h.digest("hex");
  }

  /** Returns true when this fingerprint repeats within the window. */
  observe(fingerprint: string, window = 3): boolean {
    const recent = this.history.slice(-window);
    const stuck = recent.includes(fingerprint);
    this.history.push(fingerprint);
    if (this.history.length > 12) this.history = this.history.slice(-12);
    return stuck;
  }

  static touchedFilesExist(files: string[], projectRoot: string): string[] {
    return files.filter((f) => existsSync(resolve(projectRoot, f)));
  }
}
