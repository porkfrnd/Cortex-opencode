# DEVELOPMENT

## Prerequisites

- Node ≥ 18, npm ≥ 9
- No paid services. No network calls at runtime. Zero runtime dependencies
  (only `@opencode-ai/plugin` for the plugin entry).

## Setup

```bash
npm install
npm run build        # tsc → dist/
```

## Testing

The sandbox blocks full-suite `npm test`; run each file (covers everything):

```bash
npx vitest run test/controller.test.ts
npx vitest run test/workforce.test.ts
npx vitest run test/capabilities-memory.test.ts
npx vitest run test/gauntlet.test.ts
npx vitest run test/integration.test.ts
```

Acceptance (§37, 16 steps + trivial-task check on a real defect):

```bash
npm run build && node scripts/accept.mjs
```

Current status: **36/36 tests pass, 16/16 acceptance steps pass.**

## Conventions

- TypeScript `strict`, ESM (`NodeNext`), no runtime deps in `src/` except
  `@opencode-ai/plugin` in `plugin.ts` only (keeps CLI + tests dependency-free).
- Small modules, no monoliths. Pure decision functions where possible
  (`scheduler.ts`, `rehearsal.ts`, `escalation.ts`) — they must stay testable
  without I/O.
- Every persist path goes through `redaction.ts`. New persist path without a
  redaction call is a bug.
- State machine changes: update the table in `src/state.ts` AND the
  `requireState` call sites in `src/controller.ts`, plus a test.
- Never `require()` — ESM only.

## Project script layout

- `scripts/setup.mjs` — installs `assets/` into a target project's `.opencode/`.
- `scripts/accept.mjs` — acceptance driver operating on `.accept-fixture/`
  (gitignored; never committed).
