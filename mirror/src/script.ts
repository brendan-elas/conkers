/**
 * The conker lock — docs/PLAN.md "The lock", spec/lock.md.
 *
 * Unlock:  <ownerSig|0xE2> <ownerPubKey> <preimage>
 * Lock:    pins nVersion = 1, sighash = 0xE2, nLocktime >= mintLocktime, nSequence
 *          non-final, then OP_CODESEPARATOR, then OP_PUSH_TX authenticates the
 *          preimage and the owner's key is checked. Both signatures therefore sign
 *          only the tail after the separator, and the preimage the spender pushes
 *          is about 100 bytes plus that tail.
 *
 * The OP_PUSH_TX block is Brendogg's verbatim construction from
 * vendor/semantos-core/core/wallet/src/tx/push-tx.ts (sighash flag on the alt
 * stack). It only hashes the pushed preimage, so it is digest-algorithm
 * agnostic: with flag 0xE2 the node compares against its OTDA digest.
 */
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';
import { otdaDigest, otdaPreimage, SIGHASH, type OtdaTx } from './otda.js';

// ── assembler ────────────────────────────────────────────────────────────────
export const OPS: Record<string, number> = {
  OP_0: 0x00, OP_FALSE: 0x00, OP_PUSHDATA1: 0x4c, OP_PUSHDATA2: 0x4d, OP_1NEGATE: 0x4f,
  OP_1: 0x51, OP_TRUE: 0x51, OP_2: 0x52, OP_3: 0x53, OP_4: 0x54, OP_5: 0x55, OP_6: 0x56, OP_7: 0x57, OP_8: 0x58,
  OP_9: 0x59, OP_10: 0x5a, OP_11: 0x5b, OP_12: 0x5c, OP_13: 0x5d, OP_14: 0x5e, OP_15: 0x5f, OP_16: 0x60,
  OP_NOP: 0x61, OP_IF: 0x63, OP_NOTIF: 0x64, OP_ELSE: 0x67, OP_ENDIF: 0x68, OP_VERIFY: 0x69, OP_RETURN: 0x6a,
  OP_TOALTSTACK: 0x6b, OP_FROMALTSTACK: 0x6c, OP_2DROP: 0x6d, OP_2DUP: 0x6e, OP_IFDUP: 0x73, OP_DEPTH: 0x74,
  OP_DROP: 0x75, OP_DUP: 0x76, OP_NIP: 0x77, OP_OVER: 0x78, OP_PICK: 0x79, OP_ROLL: 0x7a, OP_ROT: 0x7b,
  OP_SWAP: 0x7c, OP_TUCK: 0x7d, OP_CAT: 0x7e, OP_SPLIT: 0x7f, OP_NUM2BIN: 0x80, OP_BIN2NUM: 0x81, OP_SIZE: 0x82,
  OP_INVERT: 0x83, OP_AND: 0x84, OP_OR: 0x85, OP_XOR: 0x86, OP_EQUAL: 0x87, OP_EQUALVERIFY: 0x88,
  OP_1ADD: 0x8b, OP_1SUB: 0x8c, OP_NEGATE: 0x8f, OP_ABS: 0x90, OP_NOT: 0x91, OP_0NOTEQUAL: 0x92,
  OP_ADD: 0x93, OP_SUB: 0x94, OP_MUL: 0x95, OP_DIV: 0x96, OP_MOD: 0x97, OP_LSHIFT: 0x98, OP_RSHIFT: 0x99,
  OP_BOOLAND: 0x9a, OP_BOOLOR: 0x9b, OP_NUMEQUAL: 0x9c, OP_NUMEQUALVERIFY: 0x9d, OP_NUMNOTEQUAL: 0x9e,
  OP_LESSTHAN: 0x9f, OP_GREATERTHAN: 0xa0, OP_LESSTHANOREQUAL: 0xa1, OP_GREATERTHANOREQUAL: 0xa2,
  OP_MIN: 0xa3, OP_MAX: 0xa4, OP_WITHIN: 0xa5, OP_RIPEMD160: 0xa6, OP_SHA1: 0xa7, OP_SHA256: 0xa8,
  OP_HASH160: 0xa9, OP_HASH256: 0xaa, OP_CODESEPARATOR: 0xab, OP_CHECKSIG: 0xac, OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae, OP_CHECKMULTISIGVERIFY: 0xaf,
};
export const OP_NAME: Record<number, string> = Object.fromEntries(Object.entries(OPS).filter(([k]) => !['OP_FALSE', 'OP_TRUE'].includes(k)).map(([k, v]) => [v, k]));

export const hex = (b: Uint8Array): string => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string): Uint8Array => Uint8Array.from((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** Raw pushdata with the right length prefix. */
export function push(data: Uint8Array): Uint8Array {
  if (data.length <= 75) return Uint8Array.of(data.length, ...data);
  if (data.length <= 0xff) return Uint8Array.of(0x4c, data.length, ...data);
  return Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8, ...data);
}

/** Minimal ScriptNum encoding (little-endian sign-magnitude). */
export function scriptNum(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const neg = n < 0n; let a = neg ? -n : n; const out: number[] = [];
  while (a > 0n) { out.push(Number(a & 0xffn)); a >>= 8n; }
  if (out[out.length - 1]! & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1]! |= 0x80;
  return Uint8Array.from(out);
}
export function readScriptNum(b: Uint8Array): bigint {
  if (b.length === 0) return 0n;
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(i === b.length - 1 ? b[i]! & 0x7f : b[i]!);
  return b[b.length - 1]! & 0x80 ? -n : n;
}
/** Push a number the minimal way (OP_0 / OP_1..16 / OP_1NEGATE / ScriptNum pushdata). */
export function pushNum(n: bigint): Uint8Array {
  if (n === 0n) return Uint8Array.of(0x00);
  if (n >= 1n && n <= 16n) return Uint8Array.of(0x50 + Number(n));
  if (n === -1n) return Uint8Array.of(0x4f);
  return push(scriptNum(n));
}

/** Tokens: OP_* mnemonics, bare hex = raw pushdata (so `00` is a 1-byte push, not OP_0). */
export function asm(src: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const tok of src.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('OP_')) { const op = OPS[tok]; if (op === undefined) throw new Error(`unknown ${tok}`); parts.push(Uint8Array.of(op)); }
    else if (/^[0-9a-fA-F]+$/.test(tok) && tok.length % 2 === 0) parts.push(push(unhex(tok)));
    else throw new Error(`bad token ${tok}`);
  }
  return concat(...parts);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function toAsm(script: Uint8Array): string {
  const out: string[] = []; let i = 0;
  while (i < script.length) {
    const op = script[i]!;
    if (op >= 1 && op <= 75) { out.push(hex(script.slice(i + 1, i + 1 + op))); i += 1 + op; }
    else if (op === 0x4c) { const n = script[i + 1]!; out.push(hex(script.slice(i + 2, i + 2 + n))); i += 2 + n; }
    else if (op === 0x4d) { const n = script[i + 1]! | (script[i + 2]! << 8); out.push(hex(script.slice(i + 3, i + 3 + n))); i += 3 + n; }
    else { out.push(OP_NAME[op] ?? `0x${op.toString(16)}`); i++; }
  }
  return out.join(' ');
}

// ── Brendogg's OP_PUSH_TX (verbatim; vendor/semantos-core/core/wallet/src/tx/push-tx.ts) ──
export const PUSHTX_ASM = `
OP_HASH256 OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT
OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE
OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT
OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE
OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT
OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_TRUE OP_SPLIT OP_SWAP OP_CAT OP_SWAP
OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT 00 OP_CAT OP_BIN2NUM
OP_0 1f OP_NUM2BIN OP_1 OP_CAT OP_ADD
414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00 OP_TUCK OP_2 OP_DIV OP_OVER
OP_LESSTHAN OP_IF OP_OVER OP_MOD OP_OVER OP_2 OP_DIV OP_OVER OP_LESSTHAN OP_IF OP_SUB OP_ELSE
OP_NIP OP_ENDIF OP_ELSE OP_NIP OP_ENDIF OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL
OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT
OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_DUP
OP_0NOTEQUAL OP_SPLIT OP_DUP OP_0NOTEQUAL OP_SPLIT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT
OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SWAP OP_CAT OP_SIZE OP_SWAP OP_CAT
022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179802 OP_SWAP OP_CAT OP_SIZE
OP_SWAP OP_CAT 30 OP_SWAP OP_CAT OP_FROMALTSTACK OP_CAT
02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0
`;
export const PUSHTX_PUBKEY = unhex('02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0');

// ── the conker lock ─────────────────────────────────────────────────────────
export interface LockParams {
  /** hash160 of the owner's compressed pubkey */
  ownerPkh: Uint8Array;
  /** nLocktime floor the spend must carry (unix time or height, as minted) */
  mintLocktime: number;
}

export const CONKERS_FLAG = SIGHASH.CONKERS; // 0xE2
const FLAG_HEX = CONKERS_FLAG.toString(16); // 'e2'
const FLAG_LE32 = FLAG_HEX + '000000'; // the preimage's last 4 bytes

/** Everything before the separator: pins on the pushed preimage (copied, then dropped). */
function lockHead(p: LockParams): Uint8Array {
  return concat(
    asm('OP_DUP OP_TOALTSTACK'),
    // nVersion == 1
    asm('OP_DUP OP_4 OP_SPLIT OP_DROP 01000000 OP_EQUALVERIFY'),
    // sighash type == e2000000 (last 4 bytes)
    asm(`OP_DUP OP_SIZE OP_4 OP_SUB OP_SPLIT OP_NIP ${FLAG_LE32} OP_EQUALVERIFY`),
    // nLocktime (bytes len-8 .. len-4) >= mintLocktime; 00 appended so the number is positive
    asm('OP_DUP OP_SIZE OP_8 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP 00 OP_CAT OP_BIN2NUM'),
    pushNum(BigInt(p.mintLocktime)),
    asm('OP_GREATERTHANOREQUAL OP_VERIFY'),
    // nSequence (bytes len-13 .. len-9: before the 00 output count) != ffffffff
    asm('OP_SIZE OP_13 OP_SUB OP_SPLIT OP_NIP OP_4 OP_SPLIT OP_DROP ffffffff OP_EQUAL OP_NOT OP_VERIFY'),
  );
}

/** Everything after the separator: this is the scriptCode both signatures sign. */
export function lockTail(p: LockParams): Uint8Array {
  return concat(
    asm(`OP_FROMALTSTACK ${FLAG_HEX} OP_TOALTSTACK`),
    asm(PUSHTX_ASM),
    asm('OP_CHECKSIGVERIFY'),
    asm('OP_DUP OP_HASH160'), push(p.ownerPkh), asm('OP_EQUALVERIFY OP_CHECKSIG'),
  );
}

export function conkerLock(p: LockParams): Uint8Array {
  if (p.ownerPkh.length !== 20) throw new RangeError('ownerPkh must be 20 bytes');
  return concat(lockHead(p), asm('OP_CODESEPARATOR'), lockTail(p));
}

export interface SpendParams { tx: OtdaTx; inputIndex: number; lock: LockParams; ownerPriv: Uint8Array }

/** The preimage the unlocking script pushes: scriptCode is the tail after the separator. */
export function conkerPreimage(tx: OtdaTx, inputIndex: number, lock: LockParams): Uint8Array {
  return otdaPreimage(tx, inputIndex, lockTail(lock), CONKERS_FLAG);
}

/** Owner signature (DER, low-S) over the OTDA digest of the tail, with the 0xE2 flag appended. */
export function signOwner(tx: OtdaTx, inputIndex: number, lock: LockParams, ownerPriv: Uint8Array): Uint8Array {
  const digest = otdaDigest(tx, inputIndex, lockTail(lock), CONKERS_FLAG);
  const sig = secp256k1.sign(digest, ownerPriv, { lowS: true }).toDERRawBytes();
  return concat(sig, Uint8Array.of(CONKERS_FLAG));
}

/** The full unlocking script: <ownerSig> <ownerPubKey> <preimage>. */
export function conkerUnlock(s: SpendParams): Uint8Array {
  const pub = secp256k1.getPublicKey(s.ownerPriv, true);
  return concat(push(signOwner(s.tx, s.inputIndex, s.lock, s.ownerPriv)), push(pub), push(conkerPreimage(s.tx, s.inputIndex, s.lock)));
}

export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b));
export const hash256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/**
 * Off-chain twin of the push-tx block: the signature the script will derive from
 * `preimage`. s = (e + 2^248) mod n, low-S; r = Gx. Verifies under PUSHTX_PUBKEY.
 */
export function expectedPushTxSig(preimage: Uint8Array): Uint8Array {
  const n = secp256k1.CURVE.n;
  const e = BigInt('0x' + hex(hash256(preimage)));
  let s = (e + (1n << 248n)) % n;
  if (s > n / 2n) s = n - s;
  const r = secp256k1.CURVE.Gx;
  const der = (x: bigint): Uint8Array => { let b = unhex(x.toString(16).padStart(64, '0')); let i = 0; while (i < b.length - 1 && b[i] === 0 && !(b[i + 1]! & 0x80)) i++; b = b.slice(i); if (b[0]! & 0x80) b = concat(Uint8Array.of(0), b); return concat(Uint8Array.of(0x02, b.length), b); };
  const body = concat(der(r), der(s));
  return concat(Uint8Array.of(0x30, body.length), body, Uint8Array.of(CONKERS_FLAG));
}
