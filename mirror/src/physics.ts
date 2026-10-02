/**
 * Swing score, impact and match preview — spec/swing-score.md.
 *
 * Integer arithmetic only (BigInt where a product can pass 2^53), so the Zig
 * handler in the cell-engine reproduces these bytes exactly. Every constant
 * here is a starting guess; phase 2 step 1 replaces them with measured ones.
 *
 * Units: mass cg, speed cm/s, length cm, string strength dN (deci-newton),
 * elasticity percent, hp 0..10000, score basis points 0..10000, tension mN.
 */
import type { NutProps, StringProps } from './derive.js';

export const BP = 10000;
export const HP_MAX = 10000;

/** Tunables. Named so the Zig port can carry the same table. */
export const TUNING = {
  /** |imu - doppler| may be at most this share of the larger, in percent */
  speedAgreementPct: 25,
  speedIdealCmps: 300, speedZeroLowCmps: 150, speedZeroHighCmps: 500,
  planeZeroDeg: 25,
  twistZeroDegps: 90,
  timingZeroMs: 150,
  /** factor when the striker braked before impact (bp) */
  noFollowThroughBp: 3000,
  /** damage = J_eff^2 / ((hardness + hardnessOffset) * damageDivisor); the offset keeps the 1..100 range to a ~5x spread */
  hardnessOffset: 25n,
  damageDivisor: 475_000n,
  /** the target nut, anchored and still, takes this share of the striker's damage, percent */
  strikerEdgePct: 125,
  /** impact tension (mN) = J_eff / snapDivisor; models a ~15 ms impulse */
  snapDivisor: 150n,
  /** a match ends after this many turns if nothing broke */
  maxTurns: 20,
} as const;

export interface SwingInputs {
  imuSpeedCmps: number;
  dopplerSpeedCmps: number;
  planeDeg: number;
  twistDegps: number;
  timingMs: number;
  followThrough: boolean;
}

/** Linear fall-off from BP at `ideal` to 0 at `ideal ± zero` (asymmetric widths allowed). */
function tent(x: number, ideal: number, zeroLow: number, zeroHigh: number): number {
  const d = x - ideal;
  const w = d < 0 ? ideal - zeroLow : zeroHigh - ideal;
  const a = Math.abs(d);
  if (a >= w) return 0;
  return Math.floor((BP * (w - a)) / w);
}

const mulBp = (a: number, b: number): number => Math.floor((a * b) / BP);

/** The speed both phones agree on, or null when they disagree (turn void). */
export function agreedSpeed(imu: number, doppler: number): number | null {
  const hi = Math.max(imu, doppler);
  if (hi === 0) return null;
  if (Math.abs(imu - doppler) * 100 > hi * TUNING.speedAgreementPct) return null;
  return Math.min(imu, doppler);
}

/** Score in basis points, or null when the two speeds disagree. */
export function scoreSwing(s: SwingInputs): number | null {
  const v = agreedSpeed(s.imuSpeedCmps, s.dopplerSpeedCmps);
  if (v === null) return null;
  let score = tent(v, TUNING.speedIdealCmps, TUNING.speedZeroLowCmps, TUNING.speedZeroHighCmps);
  score = mulBp(score, tent(Math.abs(s.planeDeg), 0, -TUNING.planeZeroDeg, TUNING.planeZeroDeg));
  score = mulBp(score, tent(Math.abs(s.twistDegps), 0, -TUNING.twistZeroDegps, TUNING.twistZeroDegps));
  score = mulBp(score, tent(Math.abs(s.timingMs), 0, -TUNING.timingZeroMs, TUNING.timingZeroMs));
  score = mulBp(score, s.followThrough ? BP : TUNING.noFollowThroughBp);
  return score;
}

export interface ConkerState { nut: NutProps; string: StringProps; hp: number; intact: boolean }

export interface ImpactResult {
  /** effective impulse, cg·cm/s, after the score */
  impulse: bigint;
  damageStriker: number;
  damageTarget: number;
  snappedStriker: boolean;
  snappedTarget: boolean;
}

/** One collision. `v` is the agreed speed, `scoreBp` the swing score. */
export function impact(striker: ConkerState, target: ConkerState, v: number, scoreBp: number): ImpactResult {
  const m1 = BigInt(striker.nut.massCg), m2 = BigInt(target.nut.massCg);
  const e = BigInt(striker.nut.elasticityPct + target.nut.elasticityPct) / 2n;
  const mu = (m1 * m2) / (m1 + m2);
  const j = ((100n + e) * mu * BigInt(v)) / 100n;
  const jEff = (j * BigInt(scoreBp)) / BigInt(BP);
  const j2 = jEff * jEff;
  const dmg = (hardness: number): bigint => j2 / ((BigInt(hardness) + TUNING.hardnessOffset) * TUNING.damageDivisor);
  const damageStriker = Number(dmg(striker.nut.hardness));
  const damageTarget = Number((dmg(target.nut.hardness) * BigInt(TUNING.strikerEdgePct)) / 100n);
  const tension = (s: StringProps): bigint => (jEff / TUNING.snapDivisor) * BigInt(100 - s.elasticityPct) / 100n;
  const snaps = (s: StringProps): boolean => tension(s) > BigInt(s.strengthN) * 100n;
  return {
    impulse: jEff,
    damageStriker: Math.min(damageStriker, striker.hp),
    damageTarget: Math.min(damageTarget, target.hp),
    snappedStriker: striker.intact && snaps(striker.string),
    snappedTarget: target.intact && snaps(target.string),
  };
}

export type Turn =
  | { kind: 'swing'; striker: 'A' | 'B'; swing: SwingInputs }
  | { kind: 'withdraw'; by: 'A' | 'B' }
  | { kind: 'stall'; by: 'A' | 'B' };

export interface TurnResult { turn: number; scoreBp: number | null; impact: ImpactResult | null; void: boolean }

export interface MatchPreview {
  a: ConkerState; b: ConkerState;
  turns: TurnResult[];
  winner: 'A' | 'B' | 'draw';
  endedBy: 'knockout' | 'snap' | 'turns' | 'incomplete';
}

const out = (c: ConkerState): boolean => c.hp === 0 || !c.intact;
const clone = (c: ConkerState): ConkerState => ({ ...c, nut: { ...c.nut }, string: { ...c.string } });

/** Replays turns and returns the state both phones must agree on. */
export function previewMatch(a0: ConkerState, b0: ConkerState, turns: Turn[]): MatchPreview {
  const a = clone(a0), b = clone(b0);
  const results: TurnResult[] = [];
  let endedBy: MatchPreview['endedBy'] = 'incomplete';
  for (let i = 0; i < turns.length && i < TUNING.maxTurns; i++) {
    const t = turns[i]!;
    if (t.kind !== 'swing') { results.push({ turn: i, scoreBp: null, impact: null, void: false }); continue; }
    const score = scoreSwing(t.swing);
    const v = agreedSpeed(t.swing.imuSpeedCmps, t.swing.dopplerSpeedCmps);
    if (score === null || v === null) { results.push({ turn: i, scoreBp: null, impact: null, void: true }); continue; }
    const [s, g] = t.striker === 'A' ? [a, b] : [b, a];
    const r = impact(s, g, v, score);
    s.hp -= r.damageStriker; g.hp -= r.damageTarget;
    if (r.snappedStriker) s.intact = false;
    if (r.snappedTarget) g.intact = false;
    results.push({ turn: i, scoreBp: score, impact: r, void: false });
    if (out(a) || out(b)) { endedBy = (!a.intact || !b.intact) ? 'snap' : 'knockout'; break; }
  }
  if (endedBy === 'incomplete' && results.length >= TUNING.maxTurns) endedBy = 'turns';
  let winner: MatchPreview['winner'] = 'draw';
  if (out(a) !== out(b)) winner = out(a) ? 'B' : 'A';
  else if (endedBy === 'turns' && a.hp !== b.hp) winner = a.hp > b.hp ? 'A' : 'B';
  return { a, b, turns: results, winner, endedBy };
}
