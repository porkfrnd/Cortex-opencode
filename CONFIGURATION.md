# CONFIGURATION

Cortex works with zero configuration. Overrides live in
`.cortex/config.json` (project scope). Unknown keys are ignored; invalid
limit values fall back to defaults (limits must be finite numbers > 0).

## Limits

| Key | Default | Meaning |
|---|---|---|
| `maxGoalDepth` | 3 | Max depth of adaptively added goal chains |
| `maxDynamicGoals` | 12 | Max goals created mid-run (Gauntlet + remediation) |
| `maxTaskBudget` | 60 | Max model-call-equivalents before the scheduler stands down to 0 workers |
| `maxWorkers` | 8 | Hard ceiling on assigned workers |
| `maxConcurrentWorkers` | 4 | Hard ceiling on simultaneous workers |
| `maxGauntletRounds` | 3 | Gauntlet passes before refusal (anti-blind-loop) |
| `maxRemediationRounds` | 4 | Remediation passes before refusal |
| `maxContextChars` | 60000 | Controller context ceiling (briefs + rehearsal inputs) |
| `maxTokensEstimated` | 200000 | Estimated-token ceiling; pressure downgrades first |
| `maxExecutionMs` | 1800000 | Wall-clock ceiling per run (30 min) |

When spend crosses 65% of any budget (`tight`) the scheduler halves worker
appetite and shortens Gauntlet; past 90% (`critical`) it drops to 1 worker,
concurrency 1. Hard ceilings block with a state report — never silently.

## Memory

| Key | Default | Meaning |
|---|---|---|
| `retrievalBudgetChars` | 8000 | Hard cap on injected memory per retrieval (drops, never squeezes) |
| `maxEntriesPerProject` | 500 | Soft cap for hygiene tooling |

## Model tiers

`modelTiers: { cheap: [...], strong: [...] }` are preference hints resolved
against configured availability — classification, memory, summarization,
and status use cheap; architecture, synthesis, implementation, Gauntlet use
strong. No provider is ever hard-coded.

## Other

| Key | Default | Meaning |
|---|---|---|
| `debug` | false | Verbose controller logging via `client.app.log` |
| `busPollMs` | 1000 | Suggested poll interval for bus consumers |

## Example

```jsonc
// .cortex/config.json
{
  "limits": { "maxWorkers": 4, "maxConcurrentWorkers": 2, "maxGauntletRounds": 2 },
  "memory": { "retrievalBudgetChars": 4000 },
  "debug": true
}
```
