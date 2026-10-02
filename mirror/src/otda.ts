/**
 * Original Transaction Digest Algorithm (OTDA), selected on BSV by the
 * CHRONICLE sighash bit (0x20). Reference: vendor/semantos-core/core/cell-engine/src/sighash.zig
 * (`computeSigHashOTDA`) and docs/design/LOCKSCRIPT-CLEAVAGE.md §1.1.
 *
 * Conkers signs under NONE | ANYONECANPAY | CHRONICLE = 0xA2, so the digest
 * commits to: nVersion, this input's outpoint, scriptCode (the lock script
 * after its last OP_CODESEPARATOR, separators removed), this input's
 * nSequence, no outputs, nLocktime, and the 4-byte sighash type.
 *
 * @bsv/sdk has no CHRONICLE support, which is why this file exists.
 * STATUS: implemented from the Satoshi algorithm; cross-check against the Zig
 * test vectors is phase 1 step 5 (see docs/PLAN.md).
 */
import { sha256 } from '@noble/hashes/sha256';

export const SIGHASH = {
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  CHRONICLE: 0x20,
  FORKID: 0x40,
  ANYONECANPAY: 0x80,
  /** the Conkers lock flag */
  CONKERS: 0x02 | 0x80 | 0x20,
} as const;

export interface OtdaInput {
  /** 32 bytes, as it appears on the wire (little-endian txid) */
  prevTxId: Uint8Array;
  prevIndex: number;
  sequence: number;
}

export interface OtdaOutput {
  satoshis: bigint;
  script: Uint8Array;
}

export interface OtdaTx {
  version: number;
  inputs: OtdaInput[];
  outputs: OtdaOutput[];
  lockTime: number;
}

const OP_CODESEPARATOR = 0xab;

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array): void { this.parts.push(b); }
  u8(n: number): void { this.parts.push(Uint8Array.of(n & 0xff)); }
  u32le(n: number): void { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); this.parts.push(b); }
  u64le(n: bigint): void { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); this.parts.push(b); }
  varint(n: number): void {
    if (n < 0xfd) this.u8(n);
    else if (n <= 0xffff) { this.u8(0xfd); this.u8(n); this.u8(n >> 8); }
    else { this.u8(0xfe); this.u32le(n); }
  }
  varbytes(b: Uint8Array): void { this.varint(b.length); this.bytes(b); }
  out(): Uint8Array {
    const len = this.parts.reduce((a, p) => a + p.length, 0);
    const o = new Uint8Array(len); let at = 0;
    for (const p of this.parts) { o.set(p, at); at += p.length; }
    return o;
  }
}

/** Strip every OP_CODESEPARATOR from a script, walking push opcodes correctly. */
export function stripCodeSeparators(script: Uint8Array): Uint8Array {
  const out: number[] = []; let i = 0;
  while (i < script.length) {
    const op = script[i]!;
    let len = 1, dataLen = 0;
    if (op >= 1 && op <= 75) dataLen = op;
    else if (op === 0x4c) { dataLen = script[i + 1] ?? 0; len = 2; }
    else if (op === 0x4d) { dataLen = (script[i + 1] ?? 0) | ((script[i + 2] ?? 0) << 8); len = 3; }
    else if (op === 0x4e) { dataLen = new DataView(script.buffer, script.byteOffset + i + 1, 4).getUint32(0, true); len = 5; }
    const total = len + dataLen;
    if (op !== OP_CODESEPARATOR) for (let k = 0; k < total; k++) out.push(script[i + k]!);
    i += total;
  }
  return Uint8Array.from(out);
}

/**
 * OTDA digest for `inputIndex` of `tx`, signing `scriptCode` under `flags`.
 * `scriptCode` is the subscript from after the last executed OP_CODESEPARATOR;
 * any separators left in it are removed here, as Satoshi's algorithm does.
 */
export function otdaDigest(tx: OtdaTx, inputIndex: number, scriptCode: Uint8Array, flags: number): Uint8Array {
  const pre = otdaPreimage(tx, inputIndex, scriptCode, flags);
  if (pre.length === 32) return pre; // the SIGHASH_SINGLE bug value
  return sha256(sha256(pre));
}

/**
 * The OTDA preimage bytes (what the unlocking script pushes for OP_PUSH_TX).
 * Under 0xA2: version(4) 01 outpoint(36) varint(code) code sequence(4) 00 locktime(4) a2000000.
 */
export function otdaPreimage(tx: OtdaTx, inputIndex: number, scriptCode: Uint8Array, flags: number): Uint8Array {
  const base = flags & 0x1f;
  const anyoneCanPay = (flags & SIGHASH.ANYONECANPAY) !== 0;
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) throw new RangeError('inputIndex out of range');
  if (base === SIGHASH.SINGLE && inputIndex >= tx.outputs.length) {
    // legacy SIGHASH_SINGLE bug: the "digest" is the number 1. Conkers never uses SINGLE under OTDA.
    const one = new Uint8Array(32); one[0] = 1; return one;
  }
  const code = stripCodeSeparators(scriptCode);
  const w = new Writer();
  w.u32le(tx.version);
  const inputs = anyoneCanPay ? [tx.inputs[inputIndex]!] : tx.inputs;
  w.varint(inputs.length);
  inputs.forEach((inp, i) => {
    const isSigned = anyoneCanPay ? true : i === inputIndex;
    w.bytes(inp.prevTxId); w.u32le(inp.prevIndex);
    w.varbytes(isSigned ? code : new Uint8Array(0));
    const seq = !isSigned && (base === SIGHASH.NONE || base === SIGHASH.SINGLE) ? 0 : inp.sequence;
    w.u32le(seq);
  });
  let outputs: OtdaOutput[];
  if (base === SIGHASH.NONE) outputs = [];
  else if (base === SIGHASH.SINGLE) outputs = tx.outputs.slice(0, inputIndex + 1).map((o, i) => i < inputIndex ? { satoshis: -1n & 0xffffffffffffffffn, script: new Uint8Array(0) } : o);
  else outputs = tx.outputs;
  w.varint(outputs.length);
  for (const o of outputs) { w.u64le(o.satoshis); w.varbytes(o.script); }
  w.u32le(tx.lockTime);
  w.u32le(flags);
  return w.out();
}

// ── full transaction serialisation (for broadcasting on regtest) ──────────────
export interface FullInput extends OtdaInput { scriptSig: Uint8Array }
export interface FullTx { version: number; inputs: FullInput[]; outputs: OtdaOutput[]; lockTime: number }

export function serializeTx(tx: FullTx): Uint8Array {
  const w = new Writer();
  w.u32le(tx.version); w.varint(tx.inputs.length);
  for (const i of tx.inputs) { w.bytes(i.prevTxId); w.u32le(i.prevIndex); w.varbytes(i.scriptSig); w.u32le(i.sequence); }
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) { w.u64le(o.satoshis); w.varbytes(o.script); }
  w.u32le(tx.lockTime);
  return w.out();
}

class Reader {
  at = 0; constructor(private b: Uint8Array) {}
  u8(): number { return this.b[this.at++]!; }
  u32le(): number { const v = new DataView(this.b.buffer, this.b.byteOffset + this.at).getUint32(0, true); this.at += 4; return v; }
  u64le(): bigint { const v = new DataView(this.b.buffer, this.b.byteOffset + this.at).getBigUint64(0, true); this.at += 8; return v; }
  varint(): number { const f = this.u8(); if (f < 0xfd) return f; if (f === 0xfd) { const v = this.b[this.at]! | (this.b[this.at + 1]! << 8); this.at += 2; return v; } if (f === 0xfe) return this.u32le(); return Number(this.u64le()); }
  bytes(n: number): Uint8Array { const v = this.b.slice(this.at, this.at + n); this.at += n; return v; }
  varbytes(): Uint8Array { return this.bytes(this.varint()); }
}

export function parseTx(raw: Uint8Array): FullTx {
  const r = new Reader(raw);
  const version = r.u32le(); const nIn = r.varint(); const inputs: FullInput[] = [];
  for (let i = 0; i < nIn; i++) inputs.push({ prevTxId: r.bytes(32), prevIndex: r.u32le(), scriptSig: r.varbytes(), sequence: r.u32le() });
  const nOut = r.varint(); const outputs: OtdaOutput[] = [];
  for (let i = 0; i < nOut; i++) outputs.push({ satoshis: r.u64le(), script: r.varbytes() });
  return { version, inputs, outputs, lockTime: r.u32le() };
}

/** Display txid (big-endian hex) of a serialised transaction. */
export function txidHex(raw: Uint8Array): string {
  return Array.from(sha256(sha256(raw)).reverse(), (n) => n.toString(16).padStart(2, '0')).join('');
}
/** Display txid hex → 32 wire bytes (little-endian) for an outpoint. */
export function txidToWire(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))).reverse();
}
