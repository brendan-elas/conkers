# Handoff — cloud session → local (2026-10-02)

Read this, then `docs/PLAN.md`. Together they are the whole context of the session that built this repo.

## State

Phase 1 of 5. Steps 1 to 4 done. Step 5 half done.

| Step | Status | Where |
|---|---|---|
| 1 scaffold | done | repo root, `pnpm-workspace.yaml`, CI |
| 2 cell layouts | done | `mirror/src/cells.ts`, generated `spec/cells.md` + `cartridge.json` payloadSchema |
| 3 physics + vectors | done | `mirror/src/physics.ts`, `spec/swing-score.md`, `spec/vectors.json` (DEV issuer) |
| 4 lock + unlock | done, oracle-proven | `mirror/src/script.ts`, `mirror/src/interp.ts`, `spec/lock.md`, `scripts/conker.cs` |
| 5 verbs | TS reference done | `mirror/src/verbs.ts` |
| 5 regtest | **green** on sv-node 1.2.2 (2026-10-02) | `scripts/regtest.sh`, `mirror/scripts/regtest.ts` |
| 5 Zig brain port | not started | `brain/` (empty) |

55 tests: `pnpm install && pnpm test`.

## Do first, locally

```
scripts/regtest.sh start                      # Chronicle sv-node in Docker, chronicleactivationheight=1
pnpm --filter @conkers/mirror regtest         # mint, 0xE2 transfer with wallet fee input, 3 rejections
```

Expected last line: `ALL GREEN: …`. Ran green on 2026-10-02 after two fixes: (a) the harness runs under `vite-node` (plain `node --experimental-strip-types` cannot follow the `.js` import suffixes), and the spend picks its fee input from `listunspent` by hand because this sv-node's `fundrawtransaction` dummy-signs every existing input and fails on ours; (b) the lock flag became 0xE2, see below. 1000-sat outputs, `signrawtransactionwithwallet` and OTDA all worked first time.

## Decisions already made (do not reopen)

1. Lock flags `NONE | ANYONECANPAY | CHRONICLE | FORKID` = 0xE2, OTDA digest. (Was 0xA2 until regtest: sv-node 1.2.2 rejects any signature without FORKID, Chronicle or not. CHRONICLE on top of FORKID selects OTDA.) Outputs are not consensus-enforced; the LINEAR cell graph and signed match record enforce damage and ownership.
2. No Rúnar on the lock path. The push-tx block is Brendogg's verbatim one from `@semantos/wallet` (`vendor/semantos-core/core/wallet/src/tx/push-tx.ts`).
3. Swing sound is a real whoosh with a fixed-pitch 4.5 kHz tonal core; Doppler is measured by correlating against pre-stretched templates. Pitch never encodes anything.
4. ggwave carries identity, challenge, nonces and small turn data over sound. Co-location proof = each phone signs the nonce it heard.
5. Withdraw and stall counters live on the player (`conkers.player`, by cert id), never on the conker. No free re-swing after a withdrawal.
6. Pricing: $1 single, 3 for $2, 10 for $5 by card; BSV via x402 at half price.
7. Conkers is a world extension (#2 after jambox) per `vendor/semantos-core/docs/design/WORLD-BASE-LAYER.md`, running on OUR world-host deployment. Nothing goes upstream, nothing needs Todd.
8. `vendor/semantos-core` is a pinned shallow submodule (`9aa3168`). Only vendored packages whose deps resolve are in the workspace.

## Things learned the hard way

- The vendored `sighash.zig` says FORKID is "ignored under OTDA". For the digest, yes; for the node's signature-encoding check, no. `MUST_USE_FORKID` fires on any sig without 0x40. The TS oracle (`interp.ts`) now enforces this too.
- The Semantos cell-engine cannot run the lock: `OP_CHECKSIG` is BIP-143-only and demands FORKID, `OP_CODESEPARATOR` is a no-op, `OP_VER` fails, numbers are i64. It is the handler VM only. Proof = `mirror/src/interp.ts` oracle + Chronicle regtest.
- `core/cell-engine/tools/asm.zig` lacks OP_SPLIT / OP_BIN2NUM / OP_NUM2BIN mnemonics. Feed it hex from `toAsm(conkerLock(...))` or add the entries.
- Fine-grained GitHub tokens cannot target `semantos/semantos-core` (collaborator, not member). CI therefore skips the submodule; add a classic `repo`-scope token as `SEMANTOS_CORE_READ_TOKEN` when `web/` first imports `@semantos/world-client`.
- `@semantos/world-client`, `game-sdk`, `cell-engine` are `private: true`, not on npm. Hence the submodule.
- Hardness 1..100 with damage ∝ 1/hardness is a 100x spread; `hardnessOffset = 25` flattens it to ~5x.
- String strength is in deci-newtons and strings snap on the impact impulse (`J_eff / 150` mN), not centripetal load.

## Next after regtest is green

1. Zig port of `verbs.ts` into `brain/` as a walkers module, modelled on `cartridges/chess/brain` in the submodule, checked against `spec/vectors.json` and the TS tests. Needs Zig 0.15.2.
2. Phase 2 step 1: two-phone whoosh + Doppler + ggwave experiment (`web/`), 5 days, the riskiest thing in the plan.

## Working style

The owner uses the `i-have-adhd` skill (`~/.claude/skills/i-have-adhd`). Lead with the action, number steps, restate state each turn, give time estimates, no preamble.
