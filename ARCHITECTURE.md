# ARCHITECTURE

## Authority model

```text
MODEL (advisory) ──proposes──▶ CONTROLLER (decides) ──enforces──▶ STATE
```

The model may propose goals, workers, skills, strategies, remediation, and
completion claims. It may not mark unverified goals complete, bypass limits,
skip Gauntlet, remove goals silently, reduce verification, disable redaction,
bypass permissions, or declare completion without evidence. Each is rejected
by `CortexController.guardProposal` (exposed to the model as `cortex_guard`)
and, structurally, by the state machine: illegal transitions throw.

## Modules

| File | Responsibility |
|---|---|
| `src/controller.ts` | Pipeline orchestration; the only writer of state transitions, evidence, dispatch signals |
| `src/state.ts` | `StateStore`: transition table, JSON snapshot, JSONL transition log, goal persistence, retry accounting |
| `src/goals.ts` | Deterministic classification + initial decomposition, topological readiness, graph validation, bounded adaptive goals |
| `src/capabilities.ts` | Two-pass discovery (metadata scan, then relevance-scored selection; relevance requires token overlap) |
| `src/scheduler.ts` | `decideWorkforce`: pure decision function with diminishing-returns worker count + separate concurrency computation |
| `src/bus.ts` | `.cortex/bus/` filesystem coordination (dispatch/report/finding/signal messages, redacted at write) |
| `src/workers.ts` | Brief construction/rendering, report normalization under rehearsal input budgets |
| `src/rehearsal.ts` | Deterministic agreement/disagreement accounting + deterministic approach ranking |
| `src/implementation.ts` | (folded into controller) strategy commit + goal status advancement |
| `src/gauntlet.ts` | Adversarial scanners: tests, requirements, placeholders, security, responsive, a11y, generic-design tells |
| `src/remediation.ts` | Finding→plan mapping with parallel groups + `CycleGuard` file-state-hash oscillation detector |
| `src/verification.ts` | Evidence-chain verdict; `uncertain` instead of false success |
| `src/memory/store.ts` | JSON-file memory: ranking, budgets, consolidation, project isolation |
| `src/redaction.ts` | Secret patterns + `.env` refusal; applied before every persist |
| `src/budgets.ts` | Live spend tracking, pressure levels, pre-ceiling downgrade, model-tier routing |
| `src/escalation.ts` | LEVEL 0–5 ladder; `initialLevel` + `shouldEscalate` |
| `src/paths.ts` | `.cortex/` layout + stable project identity (git remote hash, never bare dir name) |
| `src/plugin.ts` | OpenCode plugin entry: `cortex_*` tools + `.env` guard hook |
| `src/cli.ts` | Headless CLI over the same controller |

## Runtime state (`.cortex/`)

```text
.cortex/
  state/state.json        # RunState snapshot (recoverable)
  state/transitions.jsonl # every transition: from/to/event/evidence/at/retries
  state/goals.json        # goal graph + statuses + evidence
  bus/*.json              # dispatch/report/finding/signal messages
  memory/*.json           # one file per memory entry
  evidence/*              # pipeline artifacts (never overwritten: versioned)
  config.json             # optional overrides
```

## OpenCode integration (verified against installed docs, opencode-ai 1.18.x)

- **Plugin**: module exporting `CortexPlugin(ctx) → hooks`, with
  `tool.execute.before` guard + `tool: { cortex_run, cortex_status,
  cortex_inspect, cortex_memory, cortex_guard }` built via
  `tool()` from `@opencode-ai/plugin`. Registered as
  `"plugin": ["cortex-opencode"]`.
- **Agent**: `assets/agent/cortex.md` → `.opencode/agent/cortex.md`
  (`mode: primary`, restricted posture close to Plan for verifier paths).
- **Commands**: `assets/commands/cortex{,-status,-inspect,-memory}.md` →
  `.opencode/commands/`, installed by `scripts/setup.mjs`.
- **Subagent dispatch**: the installed plugin API exposes no privileged
  subagent-spawn IPC to plugins, so worker execution is mediated through the
  bus: `dispatch` publishes briefs; the driving model (or any executor)
  performs them and returns structured reports via `rehearse`. If a future
  OpenCode version exposes native dispatch, `workers.ts` is the seam to bind
  it — the controller API does not change.
- **Permissions**: complements (never duplicates) OpenCode defaults —
  `.env` denial is treated as load-bearing; `doom_loop`/`external_directory`
  `ask` defaults are respected.

## Key invariants

1. All orchestration mutations flow through `CortexController` methods.
2. State transitions outside the table throw — no silent jumps.
3. Evidence files are append/versioned, never overwritten.
4. Every persist passes redaction; `.env` contents are refused, not redacted.
5. Scheduler output is computed, logged (`workforce-decision.json`), and
   enforced — the model never sets worker counts directly.
6. Gauntlet rounds and remediation rounds have hard ceilings; exceeding them
   blocks with a report instead of looping.
