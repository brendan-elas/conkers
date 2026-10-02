/**
 * A small Bitcoin Script interpreter for proving the conker lock off-chain.
 *
 * Covers the opcodes the lock and Brendogg's push-tx block use, with
 * arbitrary-precision ScriptNums (post-Genesis BSV) and an OP_CHECKSIG that
 * dispatches on the CHRONICLE bit to the OTDA digest in otda.ts. It is a test
 * oracle, not a consensus implementation: no minimal-encoding, no limits, no
 * NULLFAIL. Regtest on a Chronicle node (runar/integration/regtest.sh,
 * chronicleactivationheight=1) is the real check.
 */
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';
import { otdaDigest, SIGHASH, type OtdaTx } from './otda.js';
import { OPS, readScriptNum, scriptNum, concat } from './script.js';

export interface ExecContext { tx: OtdaTx; inputIndex: number }
export interface ExecResult { ok: boolean; error?: string; stack: Uint8Array[]; alt: Uint8Array[]; ops: number }

const truthy = (b: Uint8Array): boolean => { for (let i = 0; i < b.length; i++) { if (b[i] !== 0) return !(i === b.length - 1 && b[i] === 0x80); } return false; };
const bool = (v: boolean): Uint8Array => (v ? Uint8Array.of(1) : new Uint8Array(0));
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function execute(unlock: Uint8Array, lock: Uint8Array, ctx: ExecContext): ExecResult {
  const stack: Uint8Array[] = []; const alt: Uint8Array[] = []; let ops = 0;
  const fail = (error: string): ExecResult => ({ ok: false, error, stack, alt, ops });
  const run = (script: Uint8Array, isLock: boolean): string | null => {
    const cond: boolean[] = []; let codesep = 0; let pc = 0;
    const pop = (): Uint8Array => { const v = stack.pop(); if (v === undefined) throw new Error('stack underflow'); return v; };
    const num = (): bigint => readScriptNum(pop());
    const pushN = (n: bigint): void => { stack.push(scriptNum(n)); };
    while (pc < script.length) {
      const op = script[pc]!; let data: Uint8Array | null = null;
      if (op >= 1 && op <= 75) { data = script.slice(pc + 1, pc + 1 + op); pc += 1 + op; }
      else if (op === 0x4c) { const n = script[pc + 1]!; data = script.slice(pc + 2, pc + 2 + n); pc += 2 + n; }
      else if (op === 0x4d) { const n = script[pc + 1]! | (script[pc + 2]! << 8); data = script.slice(pc + 3, pc + 3 + n); pc += 3 + n; }
      else pc += 1;
      const live = cond.every(Boolean);
      if (op === OPS['OP_IF'] || op === OPS['OP_NOTIF']) { let v = false; if (live) v = truthy(pop()); if (op === OPS['OP_NOTIF']) v = !v; cond.push(v); continue; }
      if (op === OPS['OP_ELSE']) { if (!cond.length) return 'unbalanced else'; cond[cond.length - 1] = !cond[cond.length - 1]; continue; }
      if (op === OPS['OP_ENDIF']) { if (!cond.length) return 'unbalanced endif'; cond.pop(); continue; }
      if (!live) continue;
      if (data !== null) { stack.push(data); continue; }
      if (op === 0x00) { stack.push(new Uint8Array(0)); continue; }
      if (op >= 0x51 && op <= 0x60) { pushN(BigInt(op - 0x50)); continue; }
      if (op === 0x4f) { pushN(-1n); continue; }
      ops++;
      try {
        switch (op) {
          case OPS['OP_NOP']: break;
          case OPS['OP_VERIFY']: if (!truthy(pop())) return 'verify failed'; break;
          case OPS['OP_RETURN']: return 'op_return';
          case OPS['OP_TOALTSTACK']: alt.push(pop()); break;
          case OPS['OP_FROMALTSTACK']: { const v = alt.pop(); if (!v) return 'alt underflow'; stack.push(v); break; }
          case OPS['OP_DROP']: pop(); break;
          case OPS['OP_2DROP']: pop(); pop(); break;
          case OPS['OP_DUP']: { const a = pop(); stack.push(a, a); break; }
          case OPS['OP_2DUP']: { const b = pop(), a = pop(); stack.push(a, b, a, b); break; }
          case OPS['OP_NIP']: { const b = pop(); pop(); stack.push(b); break; }
          case OPS['OP_OVER']: { const b = pop(), a = pop(); stack.push(a, b, a); break; }
          case OPS['OP_SWAP']: { const b = pop(), a = pop(); stack.push(b, a); break; }
          case OPS['OP_TUCK']: { const b = pop(), a = pop(); stack.push(b, a, b); break; }
          case OPS['OP_ROT']: { const c = pop(), b = pop(), a = pop(); stack.push(b, c, a); break; }
          case OPS['OP_DEPTH']: pushN(BigInt(stack.length)); break;
          case OPS['OP_SIZE']: { const a = pop(); stack.push(a); pushN(BigInt(a.length)); break; }
          case OPS['OP_CAT']: { const b = pop(), a = pop(); stack.push(concat(a, b)); break; }
          case OPS['OP_SPLIT']: { const n = Number(num()); const a = pop(); if (n < 0 || n > a.length) return 'split out of range'; stack.push(a.slice(0, n), a.slice(n)); break; }
          case OPS['OP_NUM2BIN']: {
            const size = Number(num()); const raw = pop(); const n = readScriptNum(raw);
            let mag = scriptNum(n < 0n ? -n : n); if (mag.length && (mag[mag.length - 1]! & 0x80)) mag = mag; // already padded
            const out = new Uint8Array(size); if (mag.length > size) return 'num2bin too small'; out.set(mag);
            if (n < 0n) out[size - 1]! |= 0x80; stack.push(out); break;
          }
          case OPS['OP_BIN2NUM']: pushN(readScriptNum(pop())); break;
          case OPS['OP_EQUAL']: { const b = pop(), a = pop(); stack.push(bool(eq(a, b))); break; }
          case OPS['OP_EQUALVERIFY']: { const b = pop(), a = pop(); if (!eq(a, b)) return 'equalverify failed'; break; }
          case OPS['OP_1ADD']: pushN(num() + 1n); break;
          case OPS['OP_1SUB']: pushN(num() - 1n); break;
          case OPS['OP_NEGATE']: pushN(-num()); break;
          case OPS['OP_ABS']: { const a = num(); pushN(a < 0n ? -a : a); break; }
          case OPS['OP_NOT']: pushN(num() === 0n ? 1n : 0n); break;
          case OPS['OP_0NOTEQUAL']: pushN(num() === 0n ? 0n : 1n); break;
          case OPS['OP_ADD']: { const b = num(), a = num(); pushN(a + b); break; }
          case OPS['OP_SUB']: { const b = num(), a = num(); pushN(a - b); break; }
          case OPS['OP_MUL']: { const b = num(), a = num(); pushN(a * b); break; }
          case OPS['OP_DIV']: { const b = num(), a = num(); if (b === 0n) return 'div by zero'; pushN(a / b); break; }
          case OPS['OP_MOD']: { const b = num(), a = num(); if (b === 0n) return 'mod by zero'; pushN(a % b); break; }
          case OPS['OP_BOOLAND']: { const b = num(), a = num(); pushN(a !== 0n && b !== 0n ? 1n : 0n); break; }
          case OPS['OP_BOOLOR']: { const b = num(), a = num(); pushN(a !== 0n || b !== 0n ? 1n : 0n); break; }
          case OPS['OP_NUMEQUAL']: { const b = num(), a = num(); pushN(a === b ? 1n : 0n); break; }
          case OPS['OP_NUMEQUALVERIFY']: { const b = num(), a = num(); if (a !== b) return 'numequalverify failed'; break; }
          case OPS['OP_NUMNOTEQUAL']: { const b = num(), a = num(); pushN(a !== b ? 1n : 0n); break; }
          case OPS['OP_LESSTHAN']: { const b = num(), a = num(); pushN(a < b ? 1n : 0n); break; }
          case OPS['OP_GREATERTHAN']: { const b = num(), a = num(); pushN(a > b ? 1n : 0n); break; }
          case OPS['OP_LESSTHANOREQUAL']: { const b = num(), a = num(); pushN(a <= b ? 1n : 0n); break; }
          case OPS['OP_GREATERTHANOREQUAL']: { const b = num(), a = num(); pushN(a >= b ? 1n : 0n); break; }
          case OPS['OP_MIN']: { const b = num(), a = num(); pushN(a < b ? a : b); break; }
          case OPS['OP_MAX']: { const b = num(), a = num(); pushN(a > b ? a : b); break; }
          case OPS['OP_WITHIN']: { const hi = num(), lo = num(), x = num(); pushN(x >= lo && x < hi ? 1n : 0n); break; }
          case OPS['OP_RIPEMD160']: stack.push(ripemd160(pop())); break;
          case OPS['OP_SHA256']: stack.push(sha256(pop())); break;
          case OPS['OP_HASH160']: stack.push(ripemd160(sha256(pop()))); break;
          case OPS['OP_HASH256']: stack.push(sha256(sha256(pop()))); break;
          case OPS['OP_CODESEPARATOR']: codesep = pc; break;
          case OPS['OP_CHECKSIG']: case OPS['OP_CHECKSIGVERIFY']: {
            const pub = pop(), sig = pop();
            let ok = false;
            if (sig.length > 0 && isLock) {
              const flags = sig[sig.length - 1]!;
              // sv-node 1.2.2 CheckSignatureEncoding: FORKID is mandatory even with CHRONICLE set
              if (!(flags & SIGHASH.FORKID)) return 'Signature must use SIGHASH_FORKID';
              const der = sig.slice(0, -1);
              const code = script.slice(codesep);
              const digest = (flags & SIGHASH.CHRONICLE) ? otdaDigest(ctx.tx, ctx.inputIndex, code, flags) : null;
              if (digest === null) return 'BIP-143 not implemented in this oracle';
              try { ok = secp256k1.verify(der, digest, pub, { lowS: false }); } catch { ok = false; }
            }
            if (op === OPS['OP_CHECKSIGVERIFY']) { if (!ok) return 'checksigverify failed'; } else stack.push(bool(ok));
            break;
          }
          default: return `unsupported opcode 0x${op.toString(16)}`;
        }
      } catch (e) { return (e as Error).message; }
    }
    if (cond.length) return 'unbalanced if';
    return null;
  };
  const e1 = run(unlock, false); if (e1) return fail(`unlock: ${e1}`);
  const e2 = run(lock, true); if (e2) return fail(`lock: ${e2}`);
  if (!stack.length || !truthy(stack[stack.length - 1]!)) return fail('false top of stack');
  return { ok: true, stack, alt, ops };
}
