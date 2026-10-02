// Writes spec/vectors.json: DEV issuer key, genesis signature, derived conkers
// and impact vectors, for other tiers (Zig handler) to check against.
// Run: pnpm --filter @conkers/mirror vectors
import { writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { deriveConker } from '../src/derive.ts';
import { impact, scoreSwing, HP_MAX, type ConkerState } from '../src/physics.ts';

const hex = (b: Uint8Array) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
const GENESIS_MESSAGE = 'CONKERS-GENESIS-v1';
// DEV ONLY. The production issuer key lives in an HSM; only its pubkey and signature get published.
const devPriv = sha256(new TextEncoder().encode('conkers-dev-issuer'));
const issuer = secp256k1.getPublicKey(devPriv, true);
const genesisSig = secp256k1.sign(sha256(new TextEncoder().encode(GENESIS_MESSAGE)), devPriv).toCompactRawBytes();

const serials = [0, 1, 2, 7, 100, 4096, 65535, 4294967295];
const conkers = serials.map((serial) => deriveConker(genesisSig, serial));
const state = (i: number): ConkerState => ({ nut: conkers[i]!.nut, string: conkers[i]!.string, hp: HP_MAX, intact: true });
const swings = [
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
const vectors = {
  _warning: 'DEV issuer key. Regenerate with the production issuer before launch.',
  genesisMessage: GENESIS_MESSAGE,
  issuerPubKey: hex(issuer),
  genesisSig: hex(genesisSig),
  conkers,
  impacts,
};
writeFileSync(new URL('../../spec/vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
console.log(`spec/vectors.json: ${conkers.length} conkers, ${impacts.length} impacts`);
