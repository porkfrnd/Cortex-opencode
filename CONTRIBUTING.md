# CONTRIBUTING

1. Open an issue describing the change (bug, capability, Gauntlet check).
2. Keep the controller authoritative: no orchestration decisions in prompts,
   tools, or workers that bypass `CortexController`.
3. Add or update tests first; per-file `vitest run` must stay green
   (36 tests) and `scripts/accept.mjs` must stay 16/16.
4. Respect the budgets: new pipeline stages must declare their limits in
   `config.ts` and enforce them in code, not prose.
5. Never persist secrets; never weaken `redaction.ts`. Security-sensitive
   changes need a second reviewer.
6. Local-first: no new runtime dependency that requires payment, an account,
   or network access. Optional upgrades must degrade gracefully to offline.
7. Update `README.md` / `ARCHITECTURE.md` / `CONFIGURATION.md` with behavior
   changes.
