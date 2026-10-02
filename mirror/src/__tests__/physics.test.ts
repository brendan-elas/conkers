import { describe, expect, it } from 'vitest';
import { BP, HP_MAX, TUNING, agreedSpeed, impact, previewMatch, scoreSwing, type ConkerState, type SwingInputs } from '../physics.js';

const avg = (over: Partial<ConkerState> = {}): ConkerState => ({
  nut: { massCg: 1250, volumeCcm3: 700, hardness: 50, elasticityPct: 50 },
  string: { lengthCm: 30, strengthN: 35, elasticityPct: 15 },
  hp: HP_MAX, intact: true, ...over,
});
const perfect: SwingInputs = { imuSpeedCmps: 300, dopplerSpeedCmps: 300, planeDeg: 0, twistDegps: 0, timingMs: 0, followThrough: true };

describe('scoreSwing', () => {
  it('scores the ideal swing at 10000', () => expect(scoreSwing(perfect)).toBe(BP));
  it('falls off linearly and hits zero at the edges', () => {
    expect(scoreSwing({ ...perfect, imuSpeedCmps: 225, dopplerSpeedCmps: 225 })).toBe(5000);
    expect(scoreSwing({ ...perfect, imuSpeedCmps: 150, dopplerSpeedCmps: 150 })).toBe(0);
    expect(scoreSwing({ ...perfect, imuSpeedCmps: 500, dopplerSpeedCmps: 500 })).toBe(0);
    expect(scoreSwing({ ...perfect, planeDeg: 25 })).toBe(0);
    expect(scoreSwing({ ...perfect, twistDegps: 45 })).toBe(5000);
    expect(scoreSwing({ ...perfect, timingMs: -75 })).toBe(5000);
    expect(scoreSwing({ ...perfect, followThrough: false })).toBe(TUNING.noFollowThroughBp);
  });
  it('voids a swing when the phones disagree by more than 25%', () => {
    expect(agreedSpeed(300, 380)).toBe(300);
    expect(agreedSpeed(300, 410)).toBeNull();
    expect(scoreSwing({ ...perfect, dopplerSpeedCmps: 410 })).toBeNull();
    expect(agreedSpeed(0, 0)).toBeNull();
  });
  it('uses the lower of the two speeds', () => {
    expect(scoreSwing({ ...perfect, imuSpeedCmps: 360 })).toBe(scoreSwing(perfect));
  });
});

describe('impact', () => {
  it('an average 0.6 swing costs the target about 8% hp and the striker a bit less', () => {
    const r = impact(avg(), avg(), 300, 6000);
    expect(r.damageTarget).toBeGreaterThan(900); expect(r.damageTarget).toBeLessThan(1100);
    expect(r.damageStriker).toBeGreaterThan(700); expect(r.damageStriker).toBeLessThan(900);
    expect(r.snappedStriker).toBe(false); expect(r.snappedTarget).toBe(false);
  });
  it('harder nuts take less damage', () => {
    expect(impact(avg(), avg({ nut: { ...avg().nut, hardness: 100 } }), 300, 6000).damageTarget)
      .toBeLessThan(impact(avg(), avg({ nut: { ...avg().nut, hardness: 10 } }), 300, 6000).damageTarget);
  });
  it('a weak string snaps on a perfect hit, an average one does not', () => {
    const weak = avg({ string: { lengthCm: 25, strengthN: 10, elasticityPct: 0 } });
    expect(impact(avg(), weak, 300, BP).snappedTarget).toBe(true);
    expect(impact(avg(), avg(), 300, BP).snappedTarget).toBe(false);
  });
  it('never takes hp below zero', () => {
    const r = impact(avg(), avg({ hp: 50 }), 300, BP);
    expect(r.damageTarget).toBe(50);
  });
  it('is deterministic and integer', () => {
    const r = impact(avg(), avg(), 287, 7331);
    expect(r).toEqual(impact(avg(), avg(), 287, 7331));
    expect(Number.isInteger(r.damageTarget)).toBe(true);
  });
});

describe('previewMatch', () => {
  it('alternating average swings end on turns with the healthier nut winning or a draw', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ kind: 'swing' as const, striker: (i % 2 ? 'B' : 'A') as 'A' | 'B', swing: { ...perfect, imuSpeedCmps: 250, dopplerSpeedCmps: 250 } }));
    const m = previewMatch(avg(), avg(), turns);
    expect(m.turns.length).toBeLessThanOrEqual(20);
    expect(['turns', 'knockout']).toContain(m.endedBy);
    expect(m.a.hp).toBeGreaterThanOrEqual(0); expect(m.b.hp).toBeGreaterThanOrEqual(0);
    // pacing: average swings should settle a match in roughly 10 to 20 turns
    expect(m.turns.length).toBeGreaterThanOrEqual(10);
  });
  it('a snap ends the match for the snapped side', () => {
    const weak = avg({ string: { lengthCm: 25, strengthN: 10, elasticityPct: 0 } });
    const m = previewMatch(avg(), weak, [{ kind: 'swing', striker: 'A', swing: perfect }]);
    expect(m.endedBy).toBe('snap'); expect(m.winner).toBe('A'); expect(m.b.intact).toBe(false);
  });
  it('withdraw and stall turns change nothing', () => {
    const m = previewMatch(avg(), avg(), [{ kind: 'withdraw', by: 'B' }, { kind: 'stall', by: 'A' }]);
    expect(m.a.hp).toBe(HP_MAX); expect(m.b.hp).toBe(HP_MAX); expect(m.winner).toBe('draw'); expect(m.endedBy).toBe('incomplete');
  });
  it('a void swing is recorded and skipped', () => {
    const m = previewMatch(avg(), avg(), [{ kind: 'swing', striker: 'A', swing: { ...perfect, dopplerSpeedCmps: 100 } }]);
    expect(m.turns[0]!.void).toBe(true); expect(m.b.hp).toBe(HP_MAX);
  });
});
