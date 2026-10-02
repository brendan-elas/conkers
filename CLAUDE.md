# Conkers — project instructions

Read `docs/PLAN.md` first. It is the source of truth for scope and decisions.

## Rules
- The lock is `SIGHASH_NONE | ANYONECANPAY | CHRONICLE` (0xA2), OTDA digest. No Rúnar on the lock path.
- The swing sound is a real whoosh with a fixed-pitch tonal core. Pitch never encodes anything.
- ggwave carries identity, game setup and small data. Never the whoosh.
- Withdraw and stall counters live on the player (`conkers.player`, keyed by cert-id), never on the conker.
- `vendor/semantos-core` is a pinned shallow submodule. Nothing is pushed upstream from here.
- Only vendored packages with resolvable deps are in the workspace (see `pnpm-workspace.yaml`). Add more only when needed.

## Commands
- `pnpm install` · `pnpm test` (mirror vitest) · `pnpm typecheck`

## Style
- The owner reads with the `i-have-adhd` skill: lead with the action, number steps, state progress, time estimates, no preamble.
