import { describe, expect, it } from 'vitest';
import { otdaDigest, SIGHASH, stripCodeSeparators, type OtdaTx } from '../otda.js';

const txid = (n: number) => Uint8Array.from({ length: 32 }, () => n);
const tx: OtdaTx = {
  version: 1,
  inputs: [
    { prevTxId: txid(1), prevIndex: 0, sequence: 0xfffffffe },
    { prevTxId: txid(2), prevIndex: 3, sequence: 0xffffffff },
  ],
  outputs: [{ satoshis: 1n, script: Uint8Array.of(0x51) }],
  lockTime: 900000,
};
const code = Uint8Array.of(0x76, 0xa9, 0xab, 0x14, ...new Array(20).fill(7), 0x88, 0xac);

describe('otdaDigest under 0xE2 (NONE|ANYONECANPAY|CHRONICLE|FORKID)', () => {
  const d = otdaDigest(tx, 0, code, SIGHASH.CONKERS);
  it('ignores the other inputs (ANYONECANPAY)', () => {
    const fewer = { ...tx, inputs: [tx.inputs[0]!] };
    expect(otdaDigest(fewer, 0, code, SIGHASH.CONKERS)).toEqual(d);
  });
  it('ignores the outputs (NONE)', () => {
    const noOut = { ...tx, outputs: [] };
    expect(otdaDigest(noOut, 0, code, SIGHASH.CONKERS)).toEqual(d);
  });
  it('commits to version, locktime, sequence, outpoint and scriptCode', () => {
    expect(otdaDigest({ ...tx, version: 2 }, 0, code, SIGHASH.CONKERS)).not.toEqual(d);
    expect(otdaDigest({ ...tx, lockTime: 0 }, 0, code, SIGHASH.CONKERS)).not.toEqual(d);
    expect(otdaDigest({ ...tx, inputs: [{ ...tx.inputs[0]!, sequence: 0xffffffff }, tx.inputs[1]!] }, 0, code, SIGHASH.CONKERS)).not.toEqual(d);
    expect(otdaDigest({ ...tx, inputs: [{ ...tx.inputs[0]!, prevIndex: 1 }, tx.inputs[1]!] }, 0, code, SIGHASH.CONKERS)).not.toEqual(d);
    expect(otdaDigest(tx, 0, Uint8Array.of(0x51), SIGHASH.CONKERS)).not.toEqual(d);
  });
  it('strips OP_CODESEPARATOR from the scriptCode', () => {
    expect(stripCodeSeparators(code)).toEqual(Uint8Array.of(0x76, 0xa9, 0x14, ...new Array(20).fill(7), 0x88, 0xac));
    expect(stripCodeSeparators(Uint8Array.of(0x01, 0xab, 0xab))).toEqual(Uint8Array.of(0x01, 0xab));
  });
  it('ALL commits to outputs where NONE does not', () => {
    const all = SIGHASH.ALL | SIGHASH.CHRONICLE;
    expect(otdaDigest({ ...tx, outputs: [] }, 0, code, all)).not.toEqual(otdaDigest(tx, 0, code, all));
  });
});
