/**
 * The cartridge verbs as pure functions over cell payloads — the TypeScript
 * reference the Zig brain port (brain/) must match byte for byte.
 *
 *   mintPair     issuer-side: two payloads + the lock script for a serial
 *   verifyGenesis anyone: recompute the props and check the issuer signature
 *   resolveMatch  consume 2 nuts + 2 strings + a signed match + its turns →
 *                 successor nuts/strings and updated player records
 *   transferPair  owner-side: new owner on both cells
 *
 * Signatures in cell fields are 64-byte compact ECDSA over sha256(signedBytes).
 * certId is sha256(ownerPubKey) in this reference; the brain substitutes the
 * BRC-52 cert id, which is what the world host puts on the socket.
 */
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveConker, type Conker } from './derive.js';
import { encodeCell, decodeCell, signedBytes, type Record_ } from './cells.js';
import { HP_MAX, previewMatch, type ConkerState, type Turn, type SwingInputs } from './physics.js';
import { conkerLock, hash160, concat, hex } from './script.js';

export const GENESIS_MESSAGE = 'CONKERS-GENESIS-v1';
const utf8 = (s: string) => new TextEncoder().encode(s);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const Z32 = new Uint8Array(32), Z64 = new Uint8Array(64);

export const certIdOf = (pub: Uint8Array): Uint8Array => sha256(pub);
export const cellRef = (payload: Uint8Array): Uint8Array => sha256(payload);
export function signField(priv: Uint8Array, bytes: Uint8Array): Uint8Array { return secp256k1.sign(sha256(bytes), priv, { lowS: true }).toCompactRawBytes(); }
export function verifyField(sig: Uint8Array, bytes: Uint8Array, pub: Uint8Array): boolean { try { return secp256k1.verify(sig, sha256(bytes), pub); } catch { return false; } }

export interface MintParams { genesisSig: Uint8Array; issuerPub: Uint8Array; serial: number; ownerPub: Uint8Array; mintLocktime: number }
export interface MintedPair { conker: Conker; nut: Uint8Array; string: Uint8Array; lock: Uint8Array }

export function mintPair(p: MintParams): MintedPair {
  if (!secp256k1.verify(p.genesisSig, sha256(utf8(GENESIS_MESSAGE)), p.issuerPub)) throw new Error('genesis signature does not verify under issuer');
  const c = deriveConker(p.genesisSig, p.serial);
  const pairId = Uint8Array.from(c.pairId.match(/../g)!.map((b) => parseInt(b, 16)));
  const nut = encodeCell('nut', { serial: c.serial, pairId, massCg: c.nut.massCg, volumeCcm3: c.nut.volumeCcm3, hardness: c.nut.hardness, elasticityPct: c.nut.elasticityPct, hp: HP_MAX, wins: 0, losses: 0, generation: 0, owner: p.ownerPub, issuer: p.issuerPub, genesisSig: p.genesisSig });
  const string = encodeCell('string', { serial: c.serial, pairId, lengthCm: c.string.lengthCm, strengthN: c.string.strengthN, elasticityPct: c.string.elasticityPct, intact: 1, generation: 0, owner: p.ownerPub, issuer: p.issuerPub, genesisSig: p.genesisSig });
  return { conker: c, nut, string, lock: conkerLock({ ownerPkh: hash160(p.ownerPub), mintLocktime: p.mintLocktime }) };
}

/** Throws if the payload's props are not what its genesis signature and serial derive. */
export function verifyGenesis(kind: 'nut' | 'string', payload: Uint8Array): Record_ {
  const r = decodeCell(kind, payload);
  const sig = r['genesisSig'] as Uint8Array, issuer = r['issuer'] as Uint8Array;
  if (!secp256k1.verify(sig, sha256(utf8(GENESIS_MESSAGE)), issuer)) throw new Error(`${kind}: genesis signature invalid`);
  const c = deriveConker(sig, r['serial'] as number);
  if (hex(r['pairId'] as Uint8Array) !== c.pairId) throw new Error(`${kind}: pairId mismatch`);
  const want: Record<string, number> = kind === 'nut'
    ? { massCg: c.nut.massCg, volumeCcm3: c.nut.volumeCcm3, hardness: c.nut.hardness, elasticityPct: c.nut.elasticityPct }
    : { lengthCm: c.string.lengthCm, strengthN: c.string.strengthN, elasticityPct: c.string.elasticityPct };
  for (const [k, v] of Object.entries(want)) if (r[k] !== v) throw new Error(`${kind}.${k} forged: ${String(r[k])} != ${v}`);
  return r;
}

const state = (nut: Record_, str: Record_): ConkerState => ({
  nut: { massCg: nut['massCg'] as number, volumeCcm3: nut['volumeCcm3'] as number, hardness: nut['hardness'] as number, elasticityPct: nut['elasticityPct'] as number },
  string: { lengthCm: str['lengthCm'] as number, strengthN: str['strengthN'] as number, elasticityPct: str['elasticityPct'] as number },
  hp: nut['hp'] as number, intact: str['intact'] === 1,
});

/** sha256 chain over the turn payloads, in order, from a zero root. */
export function turnsRoot(turns: Uint8Array[]): Uint8Array {
  return turns.reduce((root, t) => sha256(concat(root, cellRef(t))), Z32);
}

export interface ResolveInput {
  nutA: Uint8Array; stringA: Uint8Array; nutB: Uint8Array; stringB: Uint8Array;
  match: Uint8Array; turns: Uint8Array[];
  arbiterPub: Uint8Array;
  playerA?: Uint8Array; playerB?: Uint8Array;
}
export interface ResolveOutput { nutA: Uint8Array; stringA: Uint8Array; nutB: Uint8Array; stringB: Uint8Array; playerA: Uint8Array; playerB: Uint8Array; winner: 'A' | 'B' | 'draw' }

export function resolveMatch(i: ResolveInput): ResolveOutput {
  const nA = verifyGenesis('nut', i.nutA), sA = verifyGenesis('string', i.stringA);
  const nB = verifyGenesis('nut', i.nutB), sB = verifyGenesis('string', i.stringB);
  if (!eq(nA['pairId'] as Uint8Array, sA['pairId'] as Uint8Array) || !eq(nB['pairId'] as Uint8Array, sB['pairId'] as Uint8Array)) throw new Error('nut and string are not a pair');
  if (!eq(nA['owner'] as Uint8Array, sA['owner'] as Uint8Array) || !eq(nB['owner'] as Uint8Array, sB['owner'] as Uint8Array)) throw new Error('nut and string owners differ');
  const ownerA = nA['owner'] as Uint8Array, ownerB = nB['owner'] as Uint8Array;
  const certA = certIdOf(ownerA), certB = certIdOf(ownerB);
  const m = decodeCell('match', i.match);
  for (const [k, v] of [['nutA', i.nutA], ['stringA', i.stringA], ['nutB', i.nutB], ['stringB', i.stringB]] as const) if (!eq(m[k] as Uint8Array, cellRef(v))) throw new Error(`match.${k} does not reference the consumed cell`);
  if (!eq(m['certA'] as Uint8Array, certA) || !eq(m['certB'] as Uint8Array, certB)) throw new Error('match certs do not match the owners');
  const signed = signedBytes('match', i.match);
  if (!verifyField(m['sigA'] as Uint8Array, signed, ownerA)) throw new Error('match: sigA invalid');
  if (!verifyField(m['sigB'] as Uint8Array, signed, ownerB)) throw new Error('match: sigB invalid');
  if (!verifyField(m['arbiterSig'] as Uint8Array, signed, i.arbiterPub)) throw new Error('match: arbiterSig invalid');
  if (m['turns'] !== i.turns.length) throw new Error('match.turns count mismatch');
  if (!eq(m['turnsRoot'] as Uint8Array, turnsRoot(i.turns))) throw new Error('match.turnsRoot mismatch');
  const matchId = m['matchId'] as Uint8Array;

  // decode and verify each turn
  const turns: Turn[] = []; const faced = { A: 0, B: 0 }, withdrew = { A: 0, B: 0 }, stalled = { A: 0, B: 0 };
  const side = (cert: Uint8Array): 'A' | 'B' => { if (eq(cert, certA)) return 'A'; if (eq(cert, certB)) return 'B'; throw new Error('turn signed by a stranger'); };
  const pubOf = (s: 'A' | 'B') => (s === 'A' ? ownerA : ownerB);
  i.turns.forEach((t, idx) => {
    const kindByte = t[4]!;
    if (kindByte === 4) {
      const s = decodeCell('swing', t);
      if (!eq(s['matchId'] as Uint8Array, matchId) || s['turn'] !== idx) throw new Error(`swing ${idx}: wrong match or index`);
      const striker = side(s['strikerCert'] as Uint8Array), target = side(s['targetCert'] as Uint8Array);
      if (striker === target) throw new Error(`swing ${idx}: striker is target`);
      const sb = signedBytes('swing', t);
      if (!verifyField(s['strikerSig'] as Uint8Array, sb, pubOf(striker))) throw new Error(`swing ${idx}: strikerSig invalid`);
      if (!verifyField(s['targetSig'] as Uint8Array, sb, pubOf(target))) throw new Error(`swing ${idx}: targetSig invalid`);
      const swing: SwingInputs = { imuSpeedCmps: s['imuSpeedCmps'] as number, dopplerSpeedCmps: s['dopplerSpeedCmps'] as number, planeDeg: s['planeDeg'] as number, twistDegps: s['twistDegps'] as number, timingMs: s['timingMs'] as number, followThrough: s['followThrough'] === 1 };
      turns.push({ kind: 'swing', striker, swing }); faced[target]++;
    } else if (kindByte === 5) {
      const w = decodeCell('withdraw', t);
      if (!eq(w['matchId'] as Uint8Array, matchId) || w['turn'] !== idx) throw new Error(`withdraw ${idx}: wrong match or index`);
      const by = side(w['byCert'] as Uint8Array); const other: 'A' | 'B' = by === 'A' ? 'B' : 'A';
      const wb = signedBytes('withdraw', t);
      const byOk = verifyField(w['sigBy'] as Uint8Array, wb, pubOf(by));
      const otherOk = verifyField(w['sigOther'] as Uint8Array, wb, pubOf(other));
      const arbOk = !eq(w['arbiterSig'] as Uint8Array, Z64) && verifyField(w['arbiterSig'] as Uint8Array, wb, i.arbiterPub);
      if (!((byOk && otherOk) || arbOk)) throw new Error(`withdraw ${idx}: needs both parties or the arbiter`);
      if (w['reason'] === 1) { turns.push({ kind: 'withdraw', by }); withdrew[by]++; faced[by]++; }
      else if (w['reason'] === 2) { turns.push({ kind: 'stall', by }); stalled[by]++; }
      else throw new Error(`withdraw ${idx}: unknown reason`);
    } else throw new Error(`turn ${idx}: not a swing or withdraw cell`);
  });

  // replay and compare with every claim
  const pre = previewMatch(state(nA, sA), state(nB, sB), turns);
  pre.turns.forEach((r, idx) => {
    if (!r.impact) return;
    const s = decodeCell('swing', i.turns[idx]!);
    if (s['scoreBp'] !== r.scoreBp || s['damageStriker'] !== r.impact.damageStriker || s['damageTarget'] !== r.impact.damageTarget) throw new Error(`swing ${idx}: claimed score/damage differ from replay`);
    const snapped = (r.impact.snappedStriker ? 1 : 0) | (r.impact.snappedTarget ? 2 : 0);
    if (s['snapped'] !== snapped) throw new Error(`swing ${idx}: claimed snap differs from replay`);
  });
  const winnerByte = pre.winner === 'draw' ? 0 : pre.winner === 'A' ? 1 : 2;
  if (m['hpA'] !== pre.a.hp || m['hpB'] !== pre.b.hp || m['intactA'] !== (pre.a.intact ? 1 : 0) || m['intactB'] !== (pre.b.intact ? 1 : 0) || m['winner'] !== winnerByte) throw new Error('match result differs from replay');

  // successors
  const succNut = (n: Record_, st: ConkerState, won: boolean, lost: boolean) => encodeCell('nut', { ...n, hp: st.hp, wins: (n['wins'] as number) + (won ? 1 : 0), losses: (n['losses'] as number) + (lost ? 1 : 0), generation: (n['generation'] as number) + 1 });
  const succStr = (s: Record_, st: ConkerState) => encodeCell('string', { ...s, intact: st.intact ? 1 : 0, generation: (s['generation'] as number) + 1 });
  const player = (prev: Uint8Array | undefined, cert: Uint8Array, s: 'A' | 'B') => {
    const p: Record_ = prev ? decodeCell('player', prev) : { certId: cert, challenges: 0, withdrawals: 0, stalls: 0, matches: 0, wins: 0, lastMatchId: Z32 };
    if (!eq(p['certId'] as Uint8Array, cert)) throw new Error('player cell belongs to someone else');
    return encodeCell('player', { ...p, challenges: (p['challenges'] as number) + faced[s], withdrawals: (p['withdrawals'] as number) + withdrew[s], stalls: (p['stalls'] as number) + stalled[s], matches: (p['matches'] as number) + 1, wins: (p['wins'] as number) + (pre.winner === s ? 1 : 0), lastMatchId: matchId });
  };
  return {
    nutA: succNut(nA, pre.a, pre.winner === 'A', pre.winner === 'B'), stringA: succStr(sA, pre.a),
    nutB: succNut(nB, pre.b, pre.winner === 'B', pre.winner === 'A'), stringB: succStr(sB, pre.b),
    playerA: player(i.playerA, certA, 'A'), playerB: player(i.playerB, certB, 'B'),
    winner: pre.winner,
  };
}

/** New owner on both cells. `sig` is the current owner's compact signature over sha256(nut || string || newOwner). */
export function transferPair(nut: Uint8Array, string: Uint8Array, newOwner: Uint8Array, sig: Uint8Array): { nut: Uint8Array; string: Uint8Array; lock: Uint8Array; mintLocktime: number } {
  const n = verifyGenesis('nut', nut), s = verifyGenesis('string', string);
  if (!eq(n['owner'] as Uint8Array, s['owner'] as Uint8Array)) throw new Error('owners differ');
  if (!verifyField(sig, concat(nut, string, newOwner), n['owner'] as Uint8Array)) throw new Error('transfer signature invalid');
  if (newOwner.length !== 33) throw new RangeError('newOwner must be a compressed pubkey');
  return {
    nut: encodeCell('nut', { ...n, owner: newOwner, generation: (n['generation'] as number) + 1 }),
    string: encodeCell('string', { ...s, owner: newOwner, generation: (s['generation'] as number) + 1 }),
    lock: conkerLock({ ownerPkh: hash160(newOwner), mintLocktime: 0 }), mintLocktime: 0,
  };
}
