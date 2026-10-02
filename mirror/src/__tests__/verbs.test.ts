import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeCell, decodeCell, signedBytes } from '../cells.js';
import { HP_MAX, previewMatch, type Turn } from '../physics.js';
import { GENESIS_MESSAGE, certIdOf, cellRef, mintPair, resolveMatch, signField, transferPair, turnsRoot, verifyGenesis } from '../verbs.js';
import { concat } from '../script.js';

const key = (s: string) => sha256(new TextEncoder().encode(s));
const issuerPriv = key('issuer'), aPriv = key('alice'), bPriv = key('bob'), arbPriv = key('arbiter');
const pub = (k: Uint8Array) => secp256k1.getPublicKey(k, true);
const genesisSig = secp256k1.sign(sha256(new TextEncoder().encode(GENESIS_MESSAGE)), issuerPriv).toCompactRawBytes();
const mint = (serial: number, owner: Uint8Array) => mintPair({ genesisSig, issuerPub: pub(issuerPriv), serial, ownerPub: owner, mintLocktime: 800000 });
const A = mint(1, pub(aPriv)), B = mint(2, pub(bPriv));
const certA = certIdOf(pub(aPriv)), certB = certIdOf(pub(bPriv));
const matchId = sha256(concat(cellRef(A.nut), cellRef(B.nut)));
const Z64 = new Uint8Array(64);
const perfect = { imuSpeedCmps: 300, dopplerSpeedCmps: 300, planeDeg: 0, twistDegps: 0, timingMs: 0, followThrough: true };

function swingCell(turn: number, striker: 'A' | 'B', inputs = perfect, over: Record<string, number> = {}) {
  const sk = striker === 'A' ? aPriv : bPriv, tk = striker === 'A' ? bPriv : aPriv;
  const stA = { nut: A.conker.nut, string: A.conker.string, hp: HP_MAX, intact: true }, stB = { nut: B.conker.nut, string: B.conker.string, hp: HP_MAX, intact: true };
  const pre = previewMatch(stA, stB, [{ kind: 'swing', striker, swing: inputs }]);
  const r = pre.turns[0]!.impact!;
  const base = { matchId, turn, strikerCert: striker === 'A' ? certA : certB, targetCert: striker === 'A' ? certB : certA, imuSpeedCmps: inputs.imuSpeedCmps, dopplerSpeedCmps: inputs.dopplerSpeedCmps, planeDeg: inputs.planeDeg, twistDegps: inputs.twistDegps, timingMs: inputs.timingMs, followThrough: inputs.followThrough ? 1 : 0, scoreBp: pre.turns[0]!.scoreBp!, damageStriker: r.damageStriker, damageTarget: r.damageTarget, snapped: (r.snappedStriker ? 1 : 0) | (r.snappedTarget ? 2 : 0), timestamp: 1n, strikerSig: Z64, targetSig: Z64, ...over };
  const unsigned = encodeCell('swing', base);
  const sb = signedBytes('swing', unsigned);
  return encodeCell('swing', { ...base, strikerSig: signField(sk, sb), targetSig: signField(tk, sb) });
}
function withdrawCell(turn: number, by: 'A' | 'B', reason: 1 | 2, arbiter = false) {
  const base = { matchId, turn, reason, byCert: by === 'A' ? certA : certB, timestamp: 2n, sigBy: Z64, sigOther: Z64, arbiterSig: Z64 };
  const sb = signedBytes('withdraw', encodeCell('withdraw', base));
  const byK = by === 'A' ? aPriv : bPriv, otherK = by === 'A' ? bPriv : aPriv;
  return encodeCell('withdraw', { ...base, sigBy: signField(byK, sb), sigOther: arbiter ? Z64 : signField(otherK, sb), arbiterSig: arbiter ? signField(arbPriv, sb) : Z64 });
}
function matchCell(turns: Uint8Array[], replayTurns: Turn[], over: Record<string, number> = {}) {
  const pre = previewMatch({ nut: A.conker.nut, string: A.conker.string, hp: HP_MAX, intact: true }, { nut: B.conker.nut, string: B.conker.string, hp: HP_MAX, intact: true }, replayTurns);
  const base = { matchId, nutA: cellRef(A.nut), stringA: cellRef(A.string), nutB: cellRef(B.nut), stringB: cellRef(B.string), certA, certB, nonceA: 7, nonceB: 9, turns: turns.length, turnsRoot: turnsRoot(turns), hpA: pre.a.hp, hpB: pre.b.hp, intactA: pre.a.intact ? 1 : 0, intactB: pre.b.intact ? 1 : 0, winner: pre.winner === 'draw' ? 0 : pre.winner === 'A' ? 1 : 2, startedAt: 1n, endedAt: 2n, sigA: Z64, sigB: Z64, arbiterSig: Z64, ...over };
  const sb = signedBytes('match', encodeCell('match', base));
  return encodeCell('match', { ...base, sigA: signField(aPriv, sb), sigB: signField(bPriv, sb), arbiterSig: signField(arbPriv, sb) });
}
// one swing each way, then B flinches, then A stalls
const turns = [swingCell(0, 'A'), swingCell(1, 'B'), withdrawCell(2, 'B', 1), withdrawCell(3, 'A', 2, true)];
const replay: Turn[] = [{ kind: 'swing', striker: 'A', swing: perfect }, { kind: 'swing', striker: 'B', swing: perfect }, { kind: 'withdraw', by: 'B' }, { kind: 'stall', by: 'A' }];
const input = () => ({ nutA: A.nut, stringA: A.string, nutB: B.nut, stringB: B.string, match: matchCell(turns, replay), turns, arbiterPub: pub(arbPriv) });

describe('mintPair / verifyGenesis', () => {
  it('mints a pair whose payloads verify and whose lock pins the owner', () => {
    expect(verifyGenesis('nut', A.nut)['hp']).toBe(HP_MAX);
    expect(verifyGenesis('string', A.string)['intact']).toBe(1);
    expect(A.lock.length).toBeGreaterThan(100);
  });
  it('rejects forged props and a foreign issuer', () => {
    const forged = encodeCell('nut', { ...decodeCell('nut', A.nut), hardness: 100 });
    expect(() => verifyGenesis('nut', forged)).toThrow(/forged/);
    expect(() => mintPair({ genesisSig, issuerPub: pub(bPriv), serial: 1, ownerPub: pub(aPriv), mintLocktime: 0 })).toThrow(/issuer/);
  });
});

describe('resolveMatch', () => {
  it('consumes the four cells and produces successors matching the replay', () => {
    const out = resolveMatch(input());
    const nA = decodeCell('nut', out.nutA), nB = decodeCell('nut', out.nutB);
    expect(nA['generation']).toBe(1); expect(nB['generation']).toBe(1);
    expect((nA['hp'] as number) + (nB['hp'] as number)).toBeLessThan(2 * HP_MAX);
    const pA = decodeCell('player', out.playerA), pB = decodeCell('player', out.playerB);
    expect(pA).toMatchObject({ challenges: 1, withdrawals: 0, stalls: 1, matches: 1 });
    expect(pB).toMatchObject({ challenges: 2, withdrawals: 1, stalls: 0, matches: 1 });
    expect((pA['wins'] as number) + (pB['wins'] as number)).toBe(out.winner === 'draw' ? 0 : 1);
  });
  it('carries an existing player record forward', () => {
    const prev = encodeCell('player', { certId: certB, challenges: 10, withdrawals: 4, stalls: 0, matches: 5, wins: 2, lastMatchId: new Uint8Array(32) });
    const out = resolveMatch({ ...input(), playerB: prev });
    expect(decodeCell('player', out.playerB)).toMatchObject({ challenges: 12, withdrawals: 5, matches: 6 });
  });
  it('rejects a swing whose claimed damage differs from the replay', () => {
    const bad = [swingCell(0, 'A', perfect, { damageTarget: 1 }), ...turns.slice(1)];
    expect(() => resolveMatch({ ...input(), turns: bad, match: matchCell(bad, replay) })).toThrow(/differ from replay/);
  });
  it('rejects a match whose claimed hp differs from the replay', () => {
    expect(() => resolveMatch({ ...input(), match: matchCell(turns, replay, { hpA: HP_MAX }) })).toThrow(/result differs/);
  });
  it('rejects a bad arbiter, a stranger arbiter, and a tampered turn list', () => {
    expect(() => resolveMatch({ ...input(), arbiterPub: pub(aPriv) })).toThrow(/arbiterSig/);
    expect(() => resolveMatch({ ...input(), turns: turns.slice(0, 3) })).toThrow(/turns count/);
    const reordered = [turns[1]!, turns[0]!, turns[2]!, turns[3]!];
    expect(() => resolveMatch({ ...input(), turns: reordered, match: matchCell(reordered, replay) })).toThrow(/wrong match or index/);
  });
  it('rejects a withdraw signed by one party without the arbiter', () => {
    const w = decodeCell('withdraw', withdrawCell(2, 'B', 1));
    const lonely = encodeCell('withdraw', { ...w, sigOther: Z64 });
    const t = [turns[0]!, turns[1]!, lonely, turns[3]!];
    expect(() => resolveMatch({ ...input(), turns: t, match: matchCell(t, replay) })).toThrow(/both parties or the arbiter/);
  });
  it('rejects a match over cells it does not reference', () => {
    const C = mint(3, pub(aPriv));
    expect(() => resolveMatch({ ...input(), nutA: C.nut, stringA: C.string })).toThrow(/does not reference/);
  });
});

describe('transferPair', () => {
  it('moves both cells to the new owner with the owner\'s signature', () => {
    const newOwner = pub(key('carol'));
    const sig = signField(aPriv, concat(A.nut, A.string, newOwner));
    const t = transferPair(A.nut, A.string, newOwner, sig);
    expect(decodeCell('nut', t.nut)['owner']).toEqual(newOwner);
    expect(decodeCell('string', t.string)['generation']).toBe(1);
    expect(() => transferPair(A.nut, A.string, newOwner, signField(bPriv, concat(A.nut, A.string, newOwner)))).toThrow(/signature/);
  });
});
