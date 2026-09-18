import type { CortexLimits } from "./types.js";

export const DEFAULT_LIMITS: CortexLimits = {
  maxGoalDepth: 3,
  maxDynamicGoals: 12,
  maxTaskBudget: 60,
  maxWorkers: 8,
  maxConcurrentWorkers: 4,
  maxGauntletRounds: 3,
  maxRemediationRounds: 4,
  maxContextChars: 60000,
  maxTokensEstimated: 200000,
  maxExecutionMs: 30 * 60 * 1000,
};

export interface CortexConfig {
  limits: CortexLimits;
  modelTiers: {
    cheap: string[];
    strong: string[];
  };
  memory: {
    retrievalBudgetChars: number;
    maxEntriesPerProject: number;
  };
  debug: boolean;
  busPollMs: number;
}

export const DEFAULT_CONFIG: CortexConfig = {
  limits: { ...DEFAULT_LIMITS },
  modelTiers: {
    // Provider/model-agnostic: resolved at runtime against configured
    // availability; these are preference hints, never hard requirements.
    cheap: ["cheap-tier", "fast-tier"],
    strong: ["strong-tier", "default"],
  },
  memory: {
    retrievalBudgetChars: 8000,
    maxEntriesPerProject: 500,
  },
  debug: false,
  busPollMs: 1000,
};

export function resolveConfig(overrides?: Partial<CortexConfig>): CortexConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    limits: { ...DEFAULT_LIMITS, ...(overrides?.limits ?? {}) },
    modelTiers: {
      cheap: overrides?.modelTiers?.cheap ?? [...DEFAULT_CONFIG.modelTiers.cheap],
      strong: overrides?.modelTiers?.strong ?? [...DEFAULT_CONFIG.modelTiers.strong],
    },
    memory: { ...DEFAULT_CONFIG.memory, ...(overrides?.memory ?? {}) },
  };
}

export function loadConfigFromJson(raw: unknown): Partial<CortexConfig> {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<CortexConfig> = {};
  if (o.limits && typeof o.limits === "object") {
    out.limits = { ...DEFAULT_LIMITS };
    for (const [k, v] of Object.entries(o.limits as Record<string, unknown>)) {
      if (k in DEFAULT_LIMITS && typeof v === "number" && Number.isFinite(v) && v > 0) {
        (out.limits as unknown as Record<string, number>)[k] = v;
      }
    }
  }
  if (typeof o.debug === "boolean") out.debug = o.debug;
  if (typeof o.busPollMs === "number" && o.busPollMs > 0) out.busPollMs = o.busPollMs;
  return out;
}
