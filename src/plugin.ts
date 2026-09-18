/**
 * Cortex OpenCode plugin entry.
 *
 * Install: `"plugin": ["cortex-opencode"]` in opencode.json / opencode.jsonc,
 * or drop this package's `assets/plugin/cortex.ts` pattern into
 * `.opencode/plugins/`. On load it registers the `cortex_*` tool family —
 * the deterministic controller surface the model drives — and attaches
 * guard hooks (secret safety + forbidden-action rejection).
 *
 * Coordination fallback (§1): native subagent IPC is not assumed. Worker
 * dispatch/collection runs over the `.cortex/bus/` filesystem bus, which the
 * tools below read and write deterministically.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { CortexController } from "./controller.js";
import { loadConfigFromJson } from "./config.js";

function controllerFor(directory: string, rawConfig?: unknown): CortexController {
  return new CortexController(directory, loadConfigFromJson(rawConfig));
}

export const CortexPlugin: Plugin = async ({ directory, client }) => {
  const log = async (message: string, level: "info" | "warn" | "error" = "info") => {
    try {
      await client.app.log({ body: { service: "cortex", level, message } });
    } catch {
      // logging is best-effort
    }
  };
  await log(`Cortex controller bound to ${directory}`);

  return {
    // Guard: never let tool input carry secrets into Cortex state/memory.
    "tool.execute.before": async (input, output) => {
      if (input.tool.startsWith("cortex_")) {
        const raw = JSON.stringify(output.args ?? {});
        if (/\.env\b/.test(raw) && /read|cat/.test(raw)) {
          throw new Error("cortex: refusing to route .env contents through Cortex state");
        }
      }
    },

    tool: {
      cortex_run: tool({
        description:
          "CORTEX: start or advance the autonomous pipeline for an objective. action=start begins a run; subsequent actions advance stages (recall, discover, goals, plan, dispatch, rehearse, implement, gauntlet, remediate, verify, learn, finish). The controller owns completion — never declare done without the verify/finish verdict.",
        args: {
          action: tool.schema.string(),
          objective: tool.schema.string().optional(),
          data: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const c = controllerFor((ctx as { directory?: string }).directory ?? directory);
          const data = args.data ? JSON.parse(args.data) : undefined;
          switch (args.action) {
            case "start":
              if (!args.objective) throw new Error("cortex_run start requires objective");
              return JSON.stringify(c.start(args.objective), null, 2);
            case "recall":
              return JSON.stringify(c.retrieveMemory(data?.objective ?? c.inspect().state?.objective ?? ""), null, 2);
            case "discover":
              return JSON.stringify(c.discover(), null, 2);
            case "goals":
              return JSON.stringify(c.formGoals(data?.objective), null, 2);
            case "plan":
              return JSON.stringify(c.planWorkforce(), null, 2);
            case "dispatch":
              return JSON.stringify(c.dispatch(), null, 2);
            case "rehearse":
              return JSON.stringify(c.rehearse(data?.reports), null, 2);
            case "implement":
              c.beginImplementation(data?.strategy);
              return "implementation strategy committed";
            case "evidence":
              c.attachEvidence(data.goalId, data.evidence);
              return "evidence attached";
            case "gauntlet":
              return JSON.stringify(c.runGauntlet(data), null, 2);
            case "remediate":
              return JSON.stringify(c.remediate(data?.touchedFiles ?? []), null, 2);
            case "verify":
              return JSON.stringify(c.verify(), null, 2);
            case "learn":
              return JSON.stringify(c.learn(data?.lessons ?? []), null, 2);
            case "finish":
              return JSON.stringify(c.finish(), null, 2);
            default:
              throw new Error(`cortex: unknown action ${args.action}`);
          }
        },
      }),

      cortex_status: tool({
        description: "CORTEX: show the live status view (objective, phase, goals, workers, concurrency, next step). Lean by default.",
        args: {},
        async execute(_args, ctx) {
          const c = controllerFor((ctx as { directory?: string }).directory ?? directory);
          return JSON.stringify(c.status(), null, 2);
        },
      }),

      cortex_inspect: tool({
        description: "CORTEX debug mode: full state, goal graph, workforce decision, Gauntlet result, verdict. Never exposes secrets.",
        args: {},
        async execute(_args, ctx) {
          const c = controllerFor((ctx as { directory?: string }).directory ?? directory);
          return JSON.stringify(c.inspect(), null, 2);
        },
      }),

      cortex_memory: tool({
        description: "CORTEX memory: action=search|consolidate|clear-project. Local-first, redacted, project-isolated.",
        args: {
          action: tool.schema.string(),
          query: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const c = controllerFor((ctx as { directory?: string }).directory ?? directory);
          if (args.action === "search") return JSON.stringify(c.searchMemory(args.query ?? ""), null, 2);
          if (args.action === "consolidate") return JSON.stringify(c.memory.consolidate(c.projectId), null, 2);
          if (args.action === "clear-project") return JSON.stringify({ cleared: c.clearProjectMemory() });
          throw new Error(`cortex: unknown memory action ${args.action}`);
        },
      }),

      cortex_guard: tool({
        description: "CORTEX authority check: ask whether a proposed orchestration action is allowed (model is advisory; controller decides).",
        args: { action: tool.schema.string() },
        async execute(args) {
          return JSON.stringify(CortexController.guardProposal(args.action), null, 2);
        },
      }),
    },
  };
};

export default CortexPlugin;
