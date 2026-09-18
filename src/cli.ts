/**
 * Headless Cortex CLI — same controller, no model required for deterministic
 * stages. Used by tests, acceptance runs, and CI.
 */
import { CortexController } from "./controller.js";

const root = process.cwd();
const [cmd, ...rest] = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = rest.findIndex((a) => a === `--${name}`);
  if (i >= 0) return rest[i + 1];
  const pref = rest.find((a) => a.startsWith(`--${name}=`));
  return pref?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const c = new CortexController(root);
  switch (cmd) {
    case "start": {
      const objective = rest.join(" ");
      if (!objective) throw new Error("usage: cortex start <objective>");
      console.log(JSON.stringify(c.start(objective), null, 2));
      break;
    }
    case "status": {
      console.log(JSON.stringify(c.status(), null, 2));
      break;
    }
    case "pipeline": {
      // Deterministic stages headless: start -> recall -> discover -> goals -> plan.
      const objective = rest.join(" ");
      if (!objective) throw new Error("usage: cortex pipeline <objective>");
      console.log("== start"); console.log(JSON.stringify(c.start(objective)));
      console.log("== recall"); console.log(JSON.stringify(c.retrieveMemory(objective)).slice(0, 500));
      console.log("== discover"); { const inv = c.discover(); console.log(`capabilities: ${inv.capabilities.length}`); }
      console.log("== goals"); { const goals = c.formGoals(); console.log(`goals: ${goals.length}`); }
      console.log("== plan"); console.log(JSON.stringify(c.planWorkforce(), null, 2));
      break;
    }
    case "gauntlet": {
      const goals = c.store.loadGoals();
      if (!goals.length) throw new Error("no goals — run pipeline first");
      const state = c.store.load()?.state;
      if (state === "WORKFORCE_PLANNING" || state === "REHEARSAL" || state === "DISPATCHING") {
        if (state === "WORKFORCE_PLANNING") {
          c.planWorkforce();
          c.dispatch();
        }
        const after = c.store.load()?.state;
        if (after === "EXECUTING" || after === "DISPATCHING") {
          c.rehearse([]);
          c.beginImplementation("headless gauntlet probe");
        } else if (after === "WORKFORCE_PLANNING" || after === "REHEARSAL") {
          c.beginImplementation("headless gauntlet probe");
        }
      }
      const r = c.runGauntlet({ runTests: arg("runTests") !== "false" });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    default:
      console.log("cortex commands: start <objective> | status | pipeline <objective> | gauntlet [--runTests=false]");
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`cortex: ${(e as Error).message}`);
  process.exitCode = 1;
});
