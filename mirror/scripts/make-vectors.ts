// Writes spec/vectors.json: DEV issuer key, genesis signature, derived conkers,
// impact vectors, and byte-exact cell / lock / verb vectors for the Zig brain
// (brain/vectors_test.zig) to check against. Everything here is deterministic
// (RFC 6979 signatures, fixed keys), so a regeneration is a no-op diff unless
// the reference changed.
// Run: pnpm --filter @conkers/mirror vectors
import { writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { deriveConker } from '../src/derive.ts';
import { impact, scoreSwing, previewMatch, HP_MAX, type ConkerState, type Turn, type SwingInputs } from '../src/physics.ts';
import { encodeCell, signedBytes } from '../src/cells.ts';
import { asm, hex, concat, PUSHTX_ASM, conkerLock } from '../src/script.ts';
import { GENESIS_MESSAGE, certIdOf, cellRef, mintPair, resolveMatch, signField, transferPair, turnsRoot } from '../src/verbs.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
// DEV ONLY. The production issuer key lives in an HSM; only its pubkey and signature get published.
const devPriv = sha256(utf8('conkers-dev-issuer'));
const issuer = secp256k1.getPublicKey(devPriv, true);
const genesisSig = secp256k1.sign(sha256(utf8(GENESIS_MESSAGE)), devPriv).toCompactRawBytes();

// ── derivation and physics ──────────────────────────────────────────────────
const serials = [0, 1, 2, 7, 100, 4096, 65535, 4294967295];
const conkers = serials.map((serial) => deriveConker(genesisSig, serial));
const state = (i: number): ConkerState => ({ nut: conkers[i]!.nut, string: conkers[i]!.string, hp: HP_MAX, intact: true });
const swings: SwingInputs[] = [
  { imuSpeedCmps: 300, dopplerSpeedCmps: 300, planeDeg: 0, twistDegps: 0, timingMs: 0, followThrough: true },
  { imuSpeedCmps: 250, dopplerSpeedCmps: 230, planeDeg: 8, twistDegps: 20, timingMs: 40, followThrough: true },
  { imuSpeedCmps: 420, dopplerSpeedCmps: 400, planeDeg: 15, twistDegps: 60, timingMs: -90, followThrough: false },
];
const impacts = [];
for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7]] as const) for (const swing of swings) {
  const scoreBp = scoreSwing(swing)!;
  const r = impact(state(i), state(j), Math.min(swing.imuSpeedCmps, swing.dopplerSpeedCmps), scoreBp);
  impacts.push({ striker: serials[i], target: serials[j], swing, scoreBp, impulse: r.impulse.toString(), damageStriker: r.damageStriker, damageTarget: r.damageTarget, snappedStriker: r.snappedStriker, snappedTarget: r.snappedTarget });
}

// ── lock bytes ──────────────────────────────────────────────────────────────
const pkh = new Uint8Array(20).fill(0xab);
const locks = [0, 5, 800000].map((mintLocktime) => ({ ownerPkh: hex(pkh), mintLocktime, lock: hex(conkerLock({ ownerPkh: pkh, mintLocktime })) }));

// ── verbs: the fixture mirror/src/__tests__/verbs.test.ts uses, made deterministic ──
const key = (s: string) => sha256(utf8(s));
const aPriv = key('alice'), bPriv = key('bob'), arbPriv = key('arbiter');
const pub = (k: Uint8Array) => secp256k1.getPublicKey(k, true);
const MINT_LOCKTIME = 800000;
const A = mintPair({ genesisSig, issuerPub: issuer, serial: 1, ownerPub: pub(aPriv), mintLocktime: MINT_LOCKTIME });
const B = mintPair({ genesisSig, issuerPub: issuer, serial: 2, ownerPub: pub(bPriv), mintLocktime: MINT_LOCKTIME });
const mints = [A, B].map((m, i) => ({ serial: i + 1, ownerPub: hex(i === 0 ? pub(aPriv) : pub(bPriv)), mintLocktime: MINT_LOCKTIME, nut: hex(m.nut), string: hex(m.string), lock: hex(m.lock) }));

const certA = certIdOf(pub(aPriv)), certB = certIdOf(pub(bPriv));
const matchId = sha256(concat(cellRef(A.nut), cellRef(B.nut)));
const Z32 = new Uint8Array(32), Z64 = new Uint8Array(64);
const stA = (): ConkerState => ({ nut: A.conker.nut, string: A.conker.string, hp: HP_MAX, intact: true });
const stB = (): ConkerState => ({ nut: B.conker.nut, string: B.conker.string, hp: HP_MAX, intact: true });

// one swing each way (the second imperfect), then B flinches, then A stalls (arbiter-ruled)
const replay: Turn[] = [{ kind: 'swing', striker: 'A', swing: swings[0]! }, { kind: 'swing', striker: 'B', swing: swings[1]! }, { kind: 'withdraw', by: 'B' }, { kind: 'stall', by: 'A' }];
const pre = previewMatch(stA(), stB(), replay);

function swingCell(turn: number, striker: 'A' | 'B', inputs: SwingInputs): Uint8Array {
  const r = pre.turns[turn]!.impact!;
  const sk = striker === 'A' ? aPriv : bPriv, tk = striker === 'A' ? bPriv : aPriv;
  const base = { matchId, turn, strikerCert: striker === 'A' ? certA : certB, targetCert: striker === 'A' ? certB : certA, imuSpeedCmps: inputs.imuSpeedCmps, dopplerSpeedCmps: inputs.dopplerSpeedCmps, planeDeg: inputs.planeDeg, twistDegps: inputs.twistDegps, timingMs: inputs.timingMs, followThrough: inputs.followThrough ? 1 : 0, scoreBp: pre.turns[turn]!.scoreBp!, damageStriker: r.damageStriker, damageTarget: r.damageTarget, snapped: (r.snappedStriker ? 1 : 0) | (r.snappedTarget ? 2 : 0), timestamp: 1000n + BigInt(turn), strikerSig: Z64, targetSig: Z64 };
  const sb = signedBytes('swing', encodeCell('swing', base));
  return encodeCell('swing', { ...base, strikerSig: signField(sk, sb), targetSig: signField(tk, sb) });
}
function withdrawCell(turn: number, by: 'A' | 'B', reason: 1 | 2, arbiter: boolean): Uint8Array {
  const base = { matchId, turn, reason, byCert: by === 'A' ? certA : certB, timestamp: 2000n + BigInt(turn), sigBy: Z64, sigOther: Z64, arbiterSig: Z64 };
  const sb = signedBytes('withdraw', encodeCell('withdraw', base));
  const byK = by === 'A' ? aPriv : bPriv, otherK = by === 'A' ? bPriv : aPriv;
  return encodeCell('withdraw', { ...base, sigBy: signField(byK, sb), sigOther: arbiter ? Z64 : signField(otherK, sb), arbiterSig: arbiter ? signField(arbPriv, sb) : Z64 });
}
const turns = [swingCell(0, 'A', swings[0]!), swingCell(1, 'B', swings[1]!), withdrawCell(2, 'B', 1, false), withdrawCell(3, 'A', 2, true)];
const matchBase = { matchId, nutA: cellRef(A.nut), stringA: cellRef(A.string), nutB: cellRef(B.nut), stringB: cellRef(B.string), certA, certB, nonceA: 7, nonceB: 9, turns: turns.length, turnsRoot: turnsRoot(turns), hpA: pre.a.hp, hpB: pre.b.hp, intactA: pre.a.intact ? 1 : 0, intactB: pre.b.intact ? 1 : 0, winner: pre.winner === 'draw' ? 0 : pre.winner === 'A' ? 1 : 2, startedAt: 1n, endedAt: 2n, sigA: Z64, sigB: Z64, arbiterSig: Z64 };
const msb = signedBytes('match', encodeCell('match', matchBase));
const match = encodeCell('match', { ...matchBase, sigA: signField(aPriv, msb), sigB: signField(bPriv, msb), arbiterSig: signField(arbPriv, msb) });
const playerB = encodeCell('player', { certId: certB, challenges: 10, withdrawals: 4, stalls: 0, matches: 5, wins: 2, lastMatchId: Z32 });
const out = resolveMatch({ nutA: A.nut, stringA: A.string, nutB: B.nut, stringB: B.string, match, turns, arbiterPub: pub(arbPriv), playerB });
const resolve = {
  nutA: hex(A.nut), stringA: hex(A.string), nutB: hex(B.nut), stringB: hex(B.string), match: hex(match), turns: turns.map(hex), arbiterPub: hex(pub(arbPriv)), playerB: hex(playerB),
  out: { nutA: hex(out.nutA), stringA: hex(out.stringA), nutB: hex(out.nutB), stringB: hex(out.stringB), playerA: hex(out.playerA), playerB: hex(out.playerB), winner: out.winner },
};

const carol = pub(key('carol'));
const tsig = signField(aPriv, concat(A.nut, A.string, carol));
const t = transferPair(A.nut, A.string, carol, tsig);
const transfer = { nut: hex(A.nut), string: hex(A.string), newOwner: hex(carol), sig: hex(tsig), out: { nut: hex(t.nut), string: hex(t.string), lock: hex(t.lock), mintLocktime: t.mintLocktime } };

const vectors = {
  _warning: 'DEV issuer key. Regenerate with the production issuer before launch.',
  genesisMessage: GENESIS_MESSAGE,
  issuerPubKey: hex(issuer),
  genesisSig: hex(genesisSig),
  conkers,
  impacts,
  pushTx: hex(asm(PUSHTX_ASM)),
  locks,
  mints,
  resolve,
  transfer,
};
writeFileSync(new URL('../../spec/vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
console.log(`spec/vectors.json: ${conkers.length} conkers, ${impacts.length} impacts, ${locks.length} locks, ${mints.length} mints, 1 resolve (${turns.length} turns, winner ${out.winner}), 1 transfer`);
