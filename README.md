# Cortex — Autonomous Execution Mode for OpenCode

Cortex turns a single objective into a managed program of work: it understands
the goal, derives a dependency graph of measurable sub-goals, discovers what
capabilities actually exist, assembles exactly as much workforce as the problem
justifies, runs it in parallel where safe, synthesizes the results, implements,
subjects the result to adversarial Gauntlet verification, remediates only what
verification found, confirms completion with evidence, and remembers what it
learned.

```text
/cortex rebuild the authentication system and make it production ready
```

Cortex owns the task from there. No manual planning, worker-picking,
skill-choosing, or verification-running.

## How it works

```text
OBJECTIVE → CONTEXT → MEMORY → CAPABILITIES → GOALS → WORKFORCE →
DISPATCH → EXECUTE → REHEARSE → IMPLEMENT → GAUNTLET →
REMEDIATE → VERIFY → LEARN → DONE
```

- **Controller owns the objective** (`src/controller.ts`). The model is
  advisory: proposals to skip verification, bypass limits, or declare
  completion without evidence are rejected by `cortex_guard` / `guardProposal`.
- **Persistent state machine** (`src/state.ts`): 18 states, a deterministic
  transition table, every transition logged with event + evidence + timestamp.
  Runs resume after interruption via `.cortex/state/`.
- **Dynamic workforce** (`src/scheduler.ts`): a real decision function in code
  — executable-goal count, dependency parallelism, complexity, specialization
  spread, model capacity, limits, remaining budget, diminishing returns.
  0 workers for trivia, N for genuinely parallel work. Never hard-coded.
- **Gauntlet** (`src/gauntlet.ts`): adversarial checks with file:line evidence
  — failing test suites, unevidenced claims, placeholders, security basics,
  responsive/a11y baselines, and a generic-AI-design tell scanner. Findings
  become bounded, targeted remediation goals (`src/remediation.ts`) with a
  file-state-hash cycle guard against oscillate-forever loops.
- **Evidence-based completion** (`src/verification.ts`): goals without
  evidence are `uncertain`, never done.
- **Local-first memory** (`src/memory/store.ts`): ranked retrieval under a
  strict context budget, consolidation that preserves failures and surfaces
  conflicts, mandatory secret redaction, project isolation via stable identity.
- **Escalation ladder** (`src/escalation.ts`): LEVEL 0 (direct) → LEVEL 5
  (full workforce + multi-round remediation). Starts low, climbs on evidence,
  never removes rigor.
- **Coordination fallback**: worker dispatch/collection runs over the
  `.cortex/bus/` filesystem bus, so Cortex works even where the plugin API
  exposes no subagent IPC. Native hooks are used where they exist
  (`tool.execute.before` guard, custom `cortex_*` tools).

## Installation

Prerequisites: OpenCode ≥ 1.x, Node ≥ 18.

```bash
npm install github:porkfrnd/Cortex-opencode
```

Then register the plugin in `opencode.json` / `opencode.jsonc`:

```jsonc
{ "plugin": ["cortex-opencode"] }
```

And install the agent + commands into your project:

```bash
npx cortex-setup
```

(When `cortex-opencode` is published to the npm registry, plain
`npm install cortex-opencode` will work the same way.)

This writes `.opencode/agent/cortex.md` and `.opencode/commands/cortex*.md`
(idempotent; won't overwrite your edits without `--force`).

### Local development install

```bash
git clone https://github.com/porkfrnd/Cortex-opencode
cd Cortex-opencode
npm install && npm run build
node scripts/setup.mjs /path/to/your/project
```

## Usage

```text
/cortex <objective>          # run the full autonomous pipeline
/cortex-status               # lean live status view
/cortex-inspect              # full debug detail (state, graph, findings)
/cortex-memory search <q>    # search project + global memory
/cortex-memory consolidate   # merge duplicates, surface conflicts
/cortex-memory clear-project # wipe this project's memory
```

Headless (CI / tests / acceptance):

```bash
cortex pipeline "Fix the queue ordering defect"
cortex gauntlet
cortex status
```

Programmatic:

```ts
import { CortexController } from "cortex-opencode/dist/controller.js";
const c = new CortexController(process.cwd());
c.start("Make listQueue production ready");
```

## Configuration

`.cortex/config.json` (all optional; see `CONFIGURATION.md`):

```jsonc
{
  "limits": {
    "maxWorkers": 8, "maxConcurrentWorkers": 4,
    "maxDynamicGoals": 12, "maxGoalDepth": 3,
    "maxGauntletRounds": 3, "maxRemediationRounds": 4,
    "maxTaskBudget": 60, "maxTokensEstimated": 200000,
    "maxExecutionMs": 1800000
  },
  "memory": { "retrievalBudgetChars": 8000, "maxEntriesPerProject": 500 },
  "debug": false
}
```

## Tests

```bash
npx vitest run test/controller.test.ts
npx vitest run test/workforce.test.ts
npx vitest run test/capabilities-memory.test.ts
npx vitest run test/gauntlet.test.ts
npx vitest run test/integration.test.ts
node scripts/accept.mjs   # §37 acceptance: 16/16 steps on a real defect
```

36 unit/integration tests + a 16-step acceptance run. See `DEVELOPMENT.md`.

## Layout

```text
src/          controller, state machine, goals, scheduler, workers,
              rehearsal, gauntlet, remediation, verification,
              memory/, capabilities, budgets, escalation, bus, plugin, cli
assets/       OpenCode integration: agent def + /cortex command family
test/         vitest suites (36 tests)
scripts/      setup.mjs (installer), accept.mjs (acceptance run)
```

## License

MIT — see `LICENSE`.
