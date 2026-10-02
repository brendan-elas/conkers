# Conkers — build plan v8

State: phase 1 of 5. Steps 1 to 4 done (scaffold, cell layouts, physics reference, lock + unlock scripts proven in an OTDA-aware oracle). Next: step 5, brain verbs and the regtest round-trip on a Chronicle node. All phase 0 decisions settled: swing is a real whoosh, ggwave for identity, setup and data, withdraw counters on the user.

## Our repo, their code as a dependency

Conkers is its own project in `brendan-elas/conkers`. It needs nothing from Todd, but it consumes semantos-core code, and the pieces it needs (`@semantos/world-client`, `@semantos/game-sdk`, `@semantos/cell-engine`) are `private: true`, not on npm. Only `protocol-types`, `wallet`, `cell-ops` and `state` are published.

1. `vendor/semantos-core` as a git submodule pinned to a commit (today `9aa3168`). Read access to `semantos/semantos-core` is all that needs.
2. `pnpm-workspace.yaml` lists our packages plus `vendor/semantos-core/packages/world-client`, `.../packages/game-sdk`, `.../core/cell-engine`, `.../core/protocol-types`, `.../core/wallet`, so `workspace:*` resolves exactly as it does in their monorepo.
3. We run our own world host from `vendor/semantos-core/runtime/world-beam` (`docker-compose.world.yml`, Phoenix on 4000, cell_relay on 5178, NATS, verifier sidecar). Conkers is registered as the extension on our instance. Nothing is pushed upstream.
4. Bumping the submodule is our choice, on our schedule. If a later upstream change breaks the extension contract we stay pinned.

Repo layout:

```
conkers/
  cartridge.json          cell types, caps, verbs, extension section
  spec/                   genesis.md, vectors.json, swing-score.md
  mirror/                 TS: deriveConker, tx builders, otdaDigest, previewMatch, scoreSwing
  scripts/                lock + unlock scripts for the sectioned assembler, cleavage-checked
  brain/                  Zig verbs: mint, resolve, transfer, withdraw
  web/                    the WorldExtension: surface, scene rigs, audio (ggwave + Doppler), commands
  world_ext/              Elixir half: arbiter, match region policy
  vendor/semantos-core    submodule
```

## Where Conkers sits

Todd's `docs/design/WORLD-BASE-LAYER.md` (merged today) plans exactly this slot: "jambox as extension #1, **a game as #2**", Phase 4 "games". Conkers is that extension. It gets, for free:

| Need | Already in the world |
|---|---|
| Room, presence, 20 Hz tick, LINEAR entities with `kind` + `owner` | `runtime/world-beam/apps/world_host` |
| Client contract: surfaces, scene objects, slash commands, lent channels, `ctx.pay(handle, sats)` | `packages/world-client/src/extension.ts` |
| Pay-to-enter rooms, creator splits, paid extensions | WORLD-BASE-LAYER §6 |
| One AudioContext per room with per-person buses and proximity gain | `packages/world-client/src/entity-audio.ts`, `proximity.ts` |
| Phone sensors with the iOS permission dance already handled | `cartridges/jambox/web/src/mappings/profiles/phone.ts` |
| Avatars, picker, camera, shatter effect | `cartridges/jambox/web/src/three/`, `archive/apps-world-client/src/shatter.ts` |
| Mic access (voice already uses it) | `peer-voice.ts`, `world-media.ts` |

## Pricing

| SKU | Price | Net after Stripe (2.9% + 30c) | Per conker |
|---|---|---|---|
| 1 | $1.00 | $0.67 | $0.67 |
| 3 | $2.00 | $1.64 | $0.55 |
| 10 | $5.00 | $4.56 | $0.46 |

BSV path via x402 at half the card price per pack. Stripe receipt via `payment-attestor-stripe`; x402 verified by `maxOutputValue`. Both land in the same mint queue.

## The lock (unchanged from v4)

Flags `NONE | ANYONECANPAY | CHRONICLE` = **0xA2**, OTDA digest. Script pins `OP_VER` = 1, scriptCode after the last `OP_CODESEPARATOR`, nLocktime and non-final sequence. No Rúnar. Digest from a TS port of `computeSigHashOTDA` in the mirror package, cross-checked against `core/cell-engine/src/sighash.zig`. Outputs are not committed, so damage and ownership transfer are enforced by the LINEAR cell graph and the signed match record.

## The swing: a real whoosh, and Doppler on it

Roles per turn: one phone is the **striker** (swung), the other is the **target** (held still, hanging).

1. **The sound is a whoosh, not a tone.** Something swinging through air. Synthesised (band-passed noise with a swept resonance) plus one steady tonal core at about 4.5 kHz. The tonal core is what the Doppler estimator locks to; the noise is what the humans hear. A sped-up wrecking-ball recording also works as a template, but 100x shortens a 10 s clip to 0.1 s and lifts everything above hearing. 10x to 20x is the useful range if we go with a recording. Synthesis is cleaner and licence-free, so that is the default.
2. **Pitch fixed, loudness live.** The whoosh's loudness follows the striker's IMU speed in real time, so the swing sounds like the swing. Its pitch never changes. If pitch tracked the swing, the target phone could not separate that from Doppler.
3. **Target listens with a known template.** The whoosh is a known waveform, so the target does not need a pure tone: it correlates the mic input against a bank of the same template pre-stretched for radial speeds from -6 to +6 m/s in 0.25 m/s steps (radar's ambiguity-function trick). Doppler scale is 1 + v/343, so 3 m/s moves the 4.5 kHz core by 39 Hz. A 0.25 s window gives 4 Hz resolution. The best-matching stretch is the measured speed. Only the radial component is seen, and at impact the striker moves straight at the target, so that is the component that matters.
4. **Two measurements, one swing.** Striker's own IMU gives speed, plane and twist. Target's Doppler gives independent speed. They must agree within 25% or the turn is void and goes to the arbiter. Neither phone alone can claim a swing.
5. **Perfect swing** (score 0 to 1, product of five factors, each a bell curve around its ideal):

| Factor | Source | Ideal | Zero at |
|---|---|---|---|
| speed at impact | Doppler + IMU | 3.0 m/s | < 1.5 or > 5.0 |
| plane | IMU gravity vector vs swing plane | 0° | > 25° |
| twist | gyro roll during swing | 0°/s | > 90°/s |
| timing | impact vs target's rest | 0 ms | ± 150 ms |
| follow-through | decel after impact, not before | — | braking before impact |

Effectiveness multiplies the impulse `J` in the damage formula. A 0.3 swing barely scratches; a 0.9 swing can snap a weak string.

Risks: a 4.5 kHz core is well inside every phone speaker and mic, so the model-dependence risk from the 18 kHz plan is gone. Room echo smears the correlation peak, so the estimator takes the earliest strong peak, not the biggest. iOS lowers speaker output when the mic is open; test early, in phase 2.

## Acoustic beacon: finding and proving the other player

"Whispernet" is Amazon's Kindle cellular network, so I assume you mean data-over-sound. What the field achieves on phone speakers and mics:

| System | Band | Rate | Range |
|---|---|---|---|
| ggwave (open source, FSK + Reed-Solomon) | 15 to 19 kHz ultrasonic profiles | 8 to 16 bytes/s (64 to 128 bit/s) | 1 to 3 m |
| BatNet (research, 8-PSK) | 20 to 24 kHz | about 600 bit/s | up to 6 m |
| Google Nearby audio tokens, SlickLogin | near-ultrasonic | tens of bit/s, one token | same room |

So sound is a beacon and setup channel, not a bulk channel. ggwave carries identity, game setup and small data; the whoosh is a separate sound.

1. **Idle beacon, ggwave.** Between turns each phone sends a 10-byte frame (8-byte cert-id prefix + 2-byte CRC) with ggwave's `ULTRASOUND_FAST` protocol: FSK from 15 kHz up, Reed-Solomon, about 1 s per frame, MIT licence, WASM build with a JS binding that runs in a browser or a Flutter webview. It was chosen because it already works across phone speakers and mics, which is the part we did not want to debug ourselves.
   ggwave's ultrasonic band runs about 15 to 19.5 kHz, well above the whoosh's 4.5 kHz core, so the two never collide.
2. **Discovery.** Hearing a beacon lists that player under "nearby" with no GPS and no server round trip. Range 1 to 3 m is the right definition of nearby for conkers.
3. **Game setup over ggwave.** Challenge, accept, which conker each side plays, and a 32-bit nonce each way, all as ggwave frames (about 1 s per 10 bytes). Each phone signs the other's nonce into the `conkers.match` cell, so the match tx carries proof both phones were within earshot.
4. **Small data over ggwave, bulk over the world channel.** Turn results (speed, score, damage: under 16 bytes) fit a ggwave frame and go over sound as well as radio, so a match survives a dropped connection. Signatures, cells and the match tx go over the lent channel.
5. **Silence during the swing.** No ggwave frame is sent while a whoosh plays, so the target's correlator hears only the whoosh.

## Withdrawal

1. The target may pull away at any moment. Their phone detects it (IMU displacement over 15 cm within 300 ms) and signs a `conkers.withdraw` cell.
2. The striker's phone sees it too: no impact, Doppler receding. Both signatures or the arbiter decides.
3. A withdrawal costs no hp and gives nothing to the striker. No free re-swing: the target could withdraw from that too. The only consequence is the **user's** record: `withdrawals` and `challenges` on a `conkers.player` cell keyed by identity (cert-id), not on the conker. Selling a conker does not launder a flincher, and buying one does not inherit someone else's nerve.
4. The striker has the mirror obligation: a turn where the striker never swings within 10 s is a `stall`, counted on the striker's player cell. Both parties must act for a turn to exist.
5. Shown on the player card as "faced 23, flinched 6, stalled 1". The conker card shows hp, wins and losses only.

## Phases

| # | Phase | Done when | Time |
|---|---|---|---|
| 0 | Decide | Done 2026-10-02 | — |
| 1 | Cartridge + mirror | `cartridges/conkers`: cell types, lock scripts, TS mirror, mint/play/transfer/withdraw, regtest round-trip | 3 weeks |
| 2 | Solo rig | Chirp + Doppler proven between two phones on a desk; three.js rig with hits, cracks, shatter, snap | 3 weeks |
| 3 | World extension | Conkers as `WorldExtension`: room, pairing, turns as lent channel, arbiter, match tx | 3 weeks |
| 4 | Money | Stripe packs, x402 packs, mint queue, collection card with history | 2 weeks |
| 5 | Later | Flutter wrapper, restring purchase, leaderboards, pay-to-enter tournaments | ongoing |

## Phase 1: Cartridge + mirror (3 weeks)

1. Repo scaffold: submodule, pnpm workspace, CI running the vendored cell-engine tests. 1 day.
2. `cartridge.json`: cells `conkers.nut` (LINEAR), `conkers.string` (LINEAR), `conkers.player` (PERSISTENT, keyed by identity: challenges, withdrawals, stalls), `conkers.swing` and `conkers.withdraw` (EPHEMERAL), `conkers.match` (EPHEMERAL); cap `cap.conkers.play`; `extensions` section per WORLD-BASE-LAYER §5.1. 2 days.
3. Genesis spec and vectors: RFC 6979 issuer signature, `h0 = sha256(S || serial)`, chain of 7. 2 days.
4. Mirror package: `deriveConker`, tx builders, `otdaDigest`, `previewMatch`, `scoreSwing`. 5 days.
5. Lock scripts in the sectioned assembler, cleavage-checked, digests matched mirror vs Zig; brain verbs `mint`, `resolve`, `transfer`, `withdraw`; regtest round-trip. 10 days.

## Phase 2: Solo rig (3 weeks)

1. Whoosh synthesis, IMU-driven loudness and ggwave beacon on one phone; template correlator and ggwave decoder on another; log Doppler vs IMU for 50 swings and beacon decode rate at 1, 2 and 3 m. 5 days. This is the riskiest step, do it first.
2. `scoreSwing` tuned from those logs. 2 days.
3. three.js `ConkerRig` (verlet string, seeded nut) beside `PlayerAvatarSystem`. 4 days.
4. Damage `.handler` in the cell-engine WASM, run in the browser. 4 days.
5. Cracks at 75/50/25, `Shatter` at 0, string snap. 3 days.

## Phase 3: World extension (3 weeks)

1. `ConkersExtension` implements `WorldExtension`: one surface (the match), scene objects (the two rigs), commands `/conkers challenge @handle`, channels `conkers:*`. 4 days.
2. Pairing: challenge by handle in the room, accept, both must be within proximity range (the world already computes it). 2 days.
3. Turns over the lent channel: `swing` cell from striker, Doppler reading from target, both sign, the opponent's cell-engine re-runs the handler. 5 days.
4. Withdraw and stall paths and the arbiter (our `world_ext/`, modelled on `world_ext_jambox`, loaded by our world host). 4 days.
5. Match end → brain `resolve` → match tx. 3 days.

## Phase 4: Money (2 weeks)

1. Stripe Checkout with the three packs; receipt → mint queue. 3 days.
2. x402 packs at half price. 3 days.
3. Mint queue → wallet-browser (BRC-100). 4 days.
4. Collection card: props, hp, wins, faced/flinched. 2 days.

## Decisions

None open. Phase 2 step 1 picks the whoosh's tonal core frequency from measurement (4.5 kHz is the starting guess).

Next: phase 1 step 5.
