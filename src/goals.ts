import { createHash } from "node:crypto";
import type { CortexLimits, Goal } from "./types.js";

const now = () => new Date().toISOString();

function uid(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

export interface ObjectiveSignals {
  touchesUI: boolean;
  touchesAPI: boolean;
  touchesDB: boolean;
  touchesAuth: boolean;
  isBugfix: boolean;
  isMigration: boolean;
  isGreenfield: boolean;
  isTrivial: boolean;
  keywords: string[];
}

const TRIVIAL_RE = /\b(rename (a |the )?variable|fix typo|typo|add comment|bump version|format)\b/i;

/** Cheap, deterministic classification pass — no model call needed. */
export function classifyObjective(objective: string): ObjectiveSignals {
  const o = objective.toLowerCase();
  return {
    touchesUI: /\b(ui|ux|frontend|react|vue|css|page|screen|component|layout|design|responsive|accessib)\b/.test(o),
    touchesAPI: /\b(api|endpoint|rest|graphql|contract|route|handler)\b/.test(o),
    touchesDB: /\b(db|database|sql|postgres|mysql|sqlite|mongo|migration|schema|prisma|drizzle)\b/.test(o),
    touchesAuth: /\b(auth|login|oauth|jwt|session|password|permission|rbac)\b/.test(o),
    isBugfix: /\b(bug|fix|broken|crash|error|fail|regress|overflow|leak)\b/.test(o),
    isMigration: /\b(migrat|upgrade|rewrite|rebuild|port)\b/.test(o),
    isGreenfield: /\b(new|create|scaffold|from scratch|greenfield|init)\b/.test(o),
    isTrivial: objective.trim().split(/\s+/).length <= 6 || TRIVIAL_RE.test(objective),
    keywords: Array.from(new Set(o.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3))).slice(0, 24),
  };
}

/**
 * Deterministic initial goal decomposition. The model may PROPOSE edits to
 * this graph; the controller accepts/rejects them (see proposeGoalChange).
 */
export function generateInitialGoals(objective: string): Goal[] {
  const s = classifyObjective(objective);
  const specs: Array<{
    key: string;
    description: string;
    criteria: string[];
    priority: number;
    deps: string[];
    caps: string[];
  }> = [];

  specs.push({
    key: "scope",
    description: `Establish scope and preserve existing behavior for: ${objective}`,
    criteria: ["Current behavior relevant to the objective is identified", "No unrelated behavior is modified"],
    priority: 1,
    deps: [],
    caps: ["filesystem", "shell"],
  });

  if (s.touchesAPI) {
    specs.push({
      key: "contracts",
      description: "Preserve or explicitly version all API contracts touched by the objective",
      criteria: ["Existing API consumers keep working", "Contract changes are documented"],
      priority: 1,
      deps: [],
      caps: ["api", "testing"],
    });
  }
  if (s.touchesDB) {
    specs.push({
      key: "data",
      description: "Keep data layer consistent (schema, migrations, queries)",
      criteria: ["Migrations apply cleanly", "No data loss on existing paths"],
      priority: 1,
      deps: [],
      caps: ["database", "testing"],
    });
  }

  specs.push({
    key: "implement",
    description: `Implement the objective: ${objective}`,
    criteria: ["Objective requirements are implemented", "Code follows repo conventions"],
    priority: 2,
    deps: specs.map((x) => x.key),
    caps: s.touchesUI ? ["frontend", "filesystem", "shell"] : ["filesystem", "shell"],
  });

  if (s.touchesUI) {
    specs.push({
      key: "responsive",
      description: "UI is responsive across breakpoints including 375px mobile",
      criteria: ["No overflow at 375px, 768px, 1440px", "Layout verified at multiple viewports"],
      priority: 2,
      deps: ["implement"],
      caps: ["frontend", "browser", "testing"],
    });
    specs.push({
      key: "a11y",
      description: "UI meets accessibility baseline (contrast, labels, keyboard)",
      criteria: ["Interactive elements are labeled", "Keyboard focus is visible", "Contrast meets WCAG AA for body text"],
      priority: 3,
      deps: ["implement"],
      caps: ["frontend", "browser", "testing"],
    });
  }
  if (s.touchesAuth) {
    specs.push({
      key: "security",
      description: "Auth/security properties hold (no secret leaks, permission checks intact)",
      criteria: ["No credentials persisted or logged", "Permission boundaries enforced"],
      priority: 1,
      deps: ["implement"],
      caps: ["security", "testing"],
    });
  }

  specs.push({
    key: "tests",
    description: "Automated tests cover the change and pass",
    criteria: ["Relevant test suite passes", "New behavior has regression coverage"],
    priority: 2,
    deps: ["implement"],
    caps: ["testing", "shell"],
  });
  specs.push({
    key: "adversarial",
    description: "Change survives adversarial Gauntlet review",
    criteria: ["Gauntlet findings are resolved or explicitly waived with reason"],
    priority: 2,
    deps: ["tests"],
    caps: ["review", "testing"],
  });
  specs.push({
    key: "integrate",
    description: "Integrate the full result (merge, docs, final verification)",
    criteria: ["Work is merged without conflicts", "Docs updated where behavior changed"],
    priority: 3,
    deps: ["adversarial"],
    caps: ["shell", "filesystem"],
  });

  const idOf = (key: string) => uid("G", `${objective}::${key}`);
  const keyToId = new Map(specs.map((sp) => [sp.key, idOf(sp.key)]));
  return specs.map((sp, i) => ({
    id: keyToId.get(sp.key)!,
    description: sp.description,
    successCriteria: sp.criteria,
    priority: sp.priority,
    dependencies: sp.deps.map((d) => keyToId.get(d)!),
    status: "proposed" as const,
    requiredCapabilities: sp.caps,
    assignedWorkers: [],
    evidence: [],
    verificationState: "unverified" as const,
    origin: "initial" as const,
    depth: 0,
    createdAt: now(),
    updatedAt: now(),
  }));
}

/** Topological readiness: goals whose dependencies are all verified. */
export function executableGoals(goals: Goal[]): Goal[] {
  const verified = new Set(goals.filter((g) => g.status === "verified").map((g) => g.id));
  return goals.filter(
    (g) =>
      (g.status === "ready" || g.status === "proposed" || g.status === "blocked") &&
      g.dependencies.every((d) => verified.has(d))
  );
}

export function validateGraph(goals: Goal[]): string[] {
  const errors: string[] = [];
  const ids = new Set(goals.map((g) => g.id));
  for (const g of goals) {
    for (const d of g.dependencies) {
      if (!ids.has(d)) errors.push(`goal ${g.id} depends on unknown goal ${d}`);
      if (d === g.id) errors.push(`goal ${g.id} depends on itself`);
    }
  }
  // cycle detection
  const visiting = new Set<string>();
  const done = new Set<string>();
  const adj = new Map(goals.map((g) => [g.id, g.dependencies]));
  const visit = (id: string, stack: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`dependency cycle: ${[...stack, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const d of adj.get(id) ?? []) visit(d, [...stack, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const g of goals) visit(g.id, []);
  return errors;
}

export interface AdaptiveRequest {
  title: string;
  description: string;
  successCriteria: string[];
  dependsOn: string[];
  source: "gauntlet" | "discovery" | "remediation";
  severity?: string;
}

/**
 * Bounded adaptive goal creation (§6). Enforces max depth and max dynamic
 * goal ceilings — returns rejection reason instead of creating.
 */
export function createAdaptiveGoal(
  goals: Goal[],
  req: AdaptiveRequest,
  limits: CortexLimits
): { goal?: Goal; rejected?: string } {
  const dynamic = goals.filter((g) => g.origin !== "initial").length;
  if (dynamic >= limits.maxDynamicGoals) {
    return { rejected: `dynamic goal ceiling reached (${limits.maxDynamicGoals})` };
  }
  const parents = goals.filter((g) => req.dependsOn.includes(g.id));
  const depth = parents.length ? Math.max(...parents.map((p) => p.depth)) + 1 : 0;
  if (depth > limits.maxGoalDepth) {
    return { rejected: `goal depth ceiling reached (${limits.maxGoalDepth})` };
  }
  const unknown = req.dependsOn.filter((d) => !goals.some((g) => g.id === d));
  if (unknown.length) return { rejected: `unknown dependencies: ${unknown.join(", ")}` };
  const id = uid("G", `${req.title}::${Date.now()}::${goals.length}`);
  const g: Goal = {
    id,
    description: req.description || req.title,
    successCriteria: req.successCriteria.length ? req.successCriteria : ["Gauntlet re-verification passes"],
    priority: req.severity === "critical" || req.severity === "high" ? 1 : 3,
    dependencies: [...req.dependsOn],
    status: "ready",
    requiredCapabilities: ["filesystem", "shell"],
    assignedWorkers: [],
    evidence: [],
    verificationState: "unverified",
    origin: req.source === "gauntlet" ? "adaptive" : "remediation",
    depth,
    createdAt: now(),
    updatedAt: now(),
  };
  const errs = validateGraph([...goals, g]);
  if (errs.length) return { rejected: errs.join("; ") };
  return { goal: g };
}
