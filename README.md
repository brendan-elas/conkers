# Conkers

Buy a conker for a dollar. Swing your phone. Hit your friend's conker. On-chain.

A conker is a pair of LINEAR Semantos cells (nut + string) locked in a BSV UTXO
under `SIGHASH_NONE | ANYONECANPAY | CHRONICLE` (0xA2). Properties come from a
hash chain over a fixed issuer signature, so anyone can verify them. Two phones
play by swinging: the striker's phone plays a whoosh, the target's phone
measures the Doppler shift, both sign the result.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Genesis (how a conker's properties are derived): [spec/genesis.md](spec/genesis.md)
- Swing scoring: [spec/swing-score.md](spec/swing-score.md)

## Layout

```
cartridge.json      cell types, caps, verbs, world-extension section
spec/               genesis, vectors, swing score
mirror/             TS: deriveConker, tx builders, OTDA digest, previewMatch, scoreSwing
scripts/            lock + unlock scripts for the Semantos sectioned assembler
brain/              Zig verbs: mint, resolve, transfer, withdraw
web/                the WorldExtension: surface, scene, audio (whoosh + ggwave), commands
world_ext/          Elixir half for our world host: arbiter, match region policy
vendor/semantos-core   git submodule, pinned
```

## Setup

```bash
git clone --recurse-submodules https://github.com/brendan-elas/conkers
cd conkers
pnpm install
pnpm test
```

The submodule is shallow and pinned. Bump it on purpose, never by accident.
