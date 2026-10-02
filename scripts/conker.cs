# conkers.nut / conkers.string — lock and unlock, sectioned-assembler form.
#
# Canonical bytes come from mirror/src/script.ts (conkerLock / conkerUnlock); this
# file is the same script for the brain's cartridge pipeline. Two gaps in
# core/cell-engine/tools/asm.zig today: no OP_SPLIT / OP_BIN2NUM / OP_NUM2BIN
# mnemonics (add them, or feed the hex from `toAsm`), and `.lockScript` is checked
# for consensus bytes only — the cell-engine cannot EXECUTE this lock (BIP-143-only
# OP_CHECKSIG, i64 numbers). Validate on a Chronicle regtest node.
#
# Constructor slots: <mintLocktime> (ScriptNum), <ownerPkh> (20 bytes).

.unlockScript {
  <SIG>            # owner signature, DER + 0xa2
  <PUBKEY>         # owner compressed pubkey
  PUSH 0x<preimage>  # OTDA preimage of this input over the post-separator tail
}

.lockScript {
  OP_DUP OP_TOALTSTACK
  OP_DUP OP_4 OP_SPLIT OP_DROP PUSH 0x01000000 OP_EQUALVERIFY
  OP_DUP OP_SIZE OP_4 OP_SUB OP_SPLIT OP_NIP PUSH 0xa2000000 OP_EQUALVERIFY
  OP_DUP OP_SIZE OP_8 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP PUSH 0x00 OP_CAT OP_BIN2NUM
  PUSH <mintLocktime> OP_GREATERTHANOREQUAL OP_VERIFY
  OP_SIZE OP_13 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP PUSH 0xffffffff OP_EQUAL OP_NOT OP_VERIFY
  OP_CODESEPARATOR
  OP_FROMALTSTACK PUSH 0xa2 OP_TOALTSTACK
  # Brendogg OP_PUSH_TX block, verbatim: vendor/semantos-core/core/wallet/src/tx/push-tx.ts
  # (omitted here for length; `toAsm(conkerLock(...))` prints the full expansion)
  OP_CHECKSIGVERIFY
  OP_DUP OP_HASH160 PUSH <ownerPkh> OP_EQUALVERIFY OP_CHECKSIG
}
