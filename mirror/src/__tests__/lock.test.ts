import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { conkerLock, conkerUnlock, conkerPreimage, lockTail, expectedPushTxSig, hash160, toAsm, asm, push, concat, PUSHTX_ASM, PUSHTX_PUBKEY, CONKERS_FLAG, signOwner } from '../script.js';
import { otdaDigest } from '../otda.js';
import { execute } from '../interp.js';
import type { OtdaTx } from '../otda.js';

const ownerPriv = sha256(new TextEncoder().encode('conkers-test-owner'));
const ownerPub = secp256k1.getPublicKey(ownerPriv, true);
const lock = { ownerPkh: hash160(ownerPub), mintLocktime: 1_700_000_000 };
const base = (): OtdaTx => ({
  version: 1,
  inputs: [
    { prevTxId: new Uint8Array(32).fill(0x11), prevIndex: 0, sequence: 0xfffffffe },
    { prevTxId: new Uint8Array(32).fill(0x22), prevIndex: 1, sequence: 0xffffffff }, // someone else's fee input
  ],
  outputs: [{ satoshis: 1n, script: asm('OP_TRUE') }],
  lockTime: 1_700_000_500,
});
const spend = (tx: OtdaTx) => execute(conkerUnlock({ tx, inputIndex: 0, lock, ownerPriv }), conkerLock(lock), { tx, inputIndex: 0 });

describe('conker lock', () => {
  it('spends with a valid owner signature, correct version, flag, locktime and non-final sequence', () => {
    const r = spend(base());
    expect(r.error).toBeUndefined(); expect(r.ok).toBe(true);
    // CLEANSTACK: one item left on the main stack, nothing on the alt stack
    expect(r.stack).toHaveLength(1); expect(r.alt).toHaveLength(0);
  });
  it('the push-tx block derives exactly the signature the mirror predicts, and it verifies under the baked pubkey', () => {
    const tx = base();
    const pre = conkerPreimage(tx, 0, lock);
    const sig = expectedPushTxSig(pre);
    const digest = otdaDigest(tx, 0, lockTail(lock), CONKERS_FLAG);
    expect(secp256k1.verify(sig.slice(0, -1), digest, PUSHTX_PUBKEY)).toBe(true);
    // run just the block on the preimage and compare the derived DER
    const r = execute(concat(push(pre), asm('a2 OP_TOALTSTACK')), asm(PUSHTX_ASM), { tx, inputIndex: 0 });
    expect(r.ok).toBe(true);
    expect(r.stack[r.stack.length - 2]).toEqual(sig);
  });
  it('rejects nVersion != 1', () => { const tx = base(); tx.version = 2; expect(spend(tx).error).toMatch(/equalverify/); });
  it('rejects a locktime below the mint floor', () => { const tx = base(); tx.lockTime = 1_699_999_999; expect(spend(tx).error).toMatch(/verify failed/); });
  it('rejects a final sequence', () => { const tx = base(); tx.inputs[0]!.sequence = 0xffffffff; expect(spend(tx).error).toMatch(/verify failed/); });
  it('rejects a wrong owner key', () => {
    const tx = base(); const other = sha256(new TextEncoder().encode('not-the-owner'));
    const r = execute(conkerUnlock({ tx, inputIndex: 0, lock, ownerPriv: other }), conkerLock(lock), { tx, inputIndex: 0 });
    expect(r.error).toMatch(/equalverify/);
  });
  it('rejects a preimage for a different transaction', () => {
    const tx = base(); const other = base(); other.lockTime = 1_800_000_000;
    const unlock = concat3(signOwner(tx, 0, lock, ownerPriv), ownerPub, conkerPreimage(other, 0, lock));
    expect(execute(unlock, conkerLock(lock), { tx, inputIndex: 0 }).error).toMatch(/checksigverify/);
  });
  it('ignores other inputs and all outputs (ANYONECANPAY | NONE)', () => {
    const tx = base(); tx.inputs.push({ prevTxId: new Uint8Array(32).fill(0x33), prevIndex: 5, sequence: 0 }); tx.outputs = [];
    expect(spend(tx).ok).toBe(true);
    const unlockFromBase = conkerUnlock({ tx: base(), inputIndex: 0, lock, ownerPriv });
    expect(execute(unlockFromBase, conkerLock(lock), { tx, inputIndex: 0 }).ok).toBe(true);
  });
  it('has the expected shape and size', () => {
    const l = conkerLock(lock); const a = toAsm(l);
    expect(a.startsWith('OP_DUP OP_TOALTSTACK OP_DUP OP_4 OP_SPLIT OP_DROP 01000000 OP_EQUALVERIFY')).toBe(true);
    expect(a).toContain('OP_CODESEPARATOR OP_FROMALTSTACK a2 OP_TOALTSTACK OP_HASH256');
    expect(a.endsWith('OP_EQUALVERIFY OP_CHECKSIG')).toBe(true);
    expect(l.length).toBeLessThan(700);
    expect(conkerPreimage(base(), 0, lock).length).toBe(4 + 1 + 36 + 3 + lockTail(lock).length + 4 + 1 + 4 + 4);
  });
});

function concat3(sig: Uint8Array, pub: Uint8Array, pre: Uint8Array): Uint8Array { return concat(push(sig), push(pub), push(pre)); }
