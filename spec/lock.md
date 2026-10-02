# The conker lock

Built by `conkerLock()` in `mirror/src/script.ts`; the same bytes in sectioned-assembler form are
`scripts/conker.cs`. Proven by `mirror/src/__tests__/lock.test.ts` against the OTDA oracle in
`mirror/src/interp.ts`. Final proof is a Chronicle regtest node (phase 1 step 5): proven 2026-10-02 on Bitcoin SV 1.2.2
with `chronicleactivationheight=1` (`scripts/regtest.sh`, `mirror/scripts/regtest.ts`).

## Spend

```
unlock:  <ownerSig | e2> <ownerPubKey> <preimage>
flags:   SIGHASH_NONE | ANYONECANPAY | CHRONICLE | FORKID = 0xE2   (OTDA digest)
version: 1   (strict malleability rules stay on; nVersion > 1 relaxes them under Chronicle)
```

## Lock, in order

| # | Bytes | Pins |
|---|---|---|
| 1 | `OP_DUP OP_TOALTSTACK` | keep the preimage for the push-tx block |
| 2 | `OP_DUP OP_4 OP_SPLIT OP_DROP 01000000 OP_EQUALVERIFY` | nVersion == 1 |
| 3 | `OP_DUP OP_SIZE OP_4 OP_SUB OP_SPLIT OP_NIP e2000000 OP_EQUALVERIFY` | sighash type == 0xE2 |
| 4 | `OP_DUP OP_SIZE OP_8 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP 00 OP_CAT OP_BIN2NUM <mintLocktime> OP_GREATERTHANOREQUAL OP_VERIFY` | nLocktime >= mint floor |
| 5 | `OP_SIZE OP_13 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP ffffffff OP_EQUAL OP_NOT OP_VERIFY` | nSequence non-final, so nLocktime is live |
| 6 | `OP_CODESEPARATOR` | everything below is the scriptCode both signatures sign |
| 7 | `OP_FROMALTSTACK e2 OP_TOALTSTACK <push-tx block> OP_CHECKSIGVERIFY` | the pushed preimage is this spend's |
| 8 | `OP_DUP OP_HASH160 <ownerPkh> OP_EQUALVERIFY OP_CHECKSIG` | the owner signed |

The push-tx block is Brendogg's verbatim construction from `vendor/semantos-core/core/wallet/src/tx/push-tx.ts`:
`e = hash256(preimage)`, `s = (e + 2^248) mod n`, low-S, `r = Gx`, DER, flag from the alt stack, fixed pubkey
`02b405…83b0`. It hashes the pushed bytes only, so it works under OTDA exactly as under BIP-143.

## Why FORKID is still set

sv-node 1.2.2 `CheckSignatureEncoding` keeps `SCRIPT_ERR_MUST_USE_FORKID` under STRICTENC with no
Chronicle exemption, and `SignatureHash` picks BIP-143 only when FORKID is set *and* CHRONICLE is
clear; every other combination is the original digest. So a Chronicle signature carries both bits.
0xA2 (no FORKID) is rejected by the node with "Signature must use SIGHASH_FORKID". The vendored
`sighash.zig` says FORKID is ignored under OTDA; it is ignored for the *digest* but not for the
encoding check, and the 0xE2 flag bytes are part of the preimage either way.

## Why the separator sits where it does

Under OTDA the scriptCode is the lock script after the last executed `OP_CODESEPARATOR`. Putting it before
step 7 means both signatures cover only steps 7 and 8, and the preimage the spender pushes is
57 bytes plus that tail (about 210 bytes), not the whole lock. Steps 1 to 5 still execute on every spend;
they just are not inside the digest.

## Preimage layout under 0xE2

```
nVersion(4) 01 outpoint(36) varint(len) scriptCode(=steps 7..8) nSequence(4) 00 nLocktime(4) e2000000
```

NONE blanks every output and ANYONECANPAY drops every other input, so the spender's conker input is
the only input the digest knows about. A match transaction can carry both players' nuts and strings
plus a fee input, each signed independently.

## What is not enforced on-chain

Outputs. The successor conker cell, the new owner, the damage: none of it is in the digest. Those are
enforced by the Semantos LINEAR cell graph (one spend per cell) and the signed match record, as the
plan says. If that ever needs to move on-chain, `play` switches to `SINGLE | ANYONECANPAY | FORKID`
(0xC3, BIP-143, since SINGLE under OTDA has the legacy bug).
