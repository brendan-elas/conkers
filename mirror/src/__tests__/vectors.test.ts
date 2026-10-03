import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { deriveConker } from '../derive.js';
import { impact, scoreSwing, HP_MAX } from '../physics.js';
import { asm, conkerLock, hex, PUSHTX_ASM, unhex } from '../script.js';
import { mintPair, resolveMatch, transferPair } from '../verbs.js';

const v = JSON.parse(readFileSync(new URL('../../../spec/vectors.json', import.meta.url), 'utf8'));

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
  it('the push-tx block and every lock re-assemble', () => {
    expect(hex(asm(PUSHTX_ASM))).toBe(v.pushTx);
    for (const l of v.locks) expect(hex(conkerLock({ ownerPkh: unhex(l.ownerPkh), mintLocktime: l.mintLocktime }))).toBe(l.lock);
  });
  it('every mint re-encodes', () => {
    for (const m of v.mints) {
      const got = mintPair({ genesisSig: unhex(v.genesisSig), issuerPub: unhex(v.issuerPubKey), serial: m.serial, ownerPub: unhex(m.ownerPub), mintLocktime: m.mintLocktime });
      expect({ nut: hex(got.nut), string: hex(got.string), lock: hex(got.lock) }).toEqual({ nut: m.nut, string: m.string, lock: m.lock });
    }
  });
  it('the resolve vector re-resolves', () => {
    const r = v.resolve;
    const out = resolveMatch({ nutA: unhex(r.nutA), stringA: unhex(r.stringA), nutB: unhex(r.nutB), stringB: unhex(r.stringB), match: unhex(r.match), turns: r.turns.map(unhex), arbiterPub: unhex(r.arbiterPub), playerB: unhex(r.playerB) });
    expect({ nutA: hex(out.nutA), stringA: hex(out.stringA), nutB: hex(out.nutB), stringB: hex(out.stringB), playerA: hex(out.playerA), playerB: hex(out.playerB), winner: out.winner }).toEqual(r.out);
  });
  it('the transfer vector re-transfers', () => {
    const t = v.transfer;
    const out = transferPair(unhex(t.nut), unhex(t.string), unhex(t.newOwner), unhex(t.sig));
    expect({ nut: hex(out.nut), string: hex(out.string), lock: hex(out.lock), mintLocktime: out.mintLocktime }).toEqual(t.out);
  });
});
