import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { deriveConker } from '../derive.js';
import { impact, scoreSwing, HP_MAX } from '../physics.js';

const v = JSON.parse(readFileSync(new URL('../../../spec/vectors.json', import.meta.url), 'utf8'));
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe('spec/vectors.json', () => {
  it('genesis signature verifies under the issuer key', () => {
    expect(secp256k1.verify(unhex(v.genesisSig), sha256(new TextEncoder().encode(v.genesisMessage)), unhex(v.issuerPubKey))).toBe(true);
  });
  it('every conker re-derives', () => {
    for (const c of v.conkers) expect(deriveConker(unhex(v.genesisSig), c.serial)).toEqual(c);
  });
  it('every impact re-computes', () => {
    const byserial = (s: number) => v.conkers.find((c: { serial: number }) => c.serial === s);
    for (const i of v.impacts) {
      const st = (s: number) => ({ nut: byserial(s).nut, string: byserial(s).string, hp: HP_MAX, intact: true });
      expect(scoreSwing(i.swing)).toBe(i.scoreBp);
      const r = impact(st(i.striker), st(i.target), Math.min(i.swing.imuSpeedCmps, i.swing.dopplerSpeedCmps), i.scoreBp);
      expect({ ...r, impulse: r.impulse.toString() }).toEqual({ impulse: i.impulse, damageStriker: i.damageStriker, damageTarget: i.damageTarget, snappedStriker: i.snappedStriker, snappedTarget: i.snappedTarget });
    }
  });
});
