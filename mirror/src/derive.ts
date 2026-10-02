/**
 * Genesis derivation — spec/genesis.md.
 *
 * h0 = sha256(S || serial_be32); hn = sha256(h(n-1)) for n = 1..7.
 * One property per hash. Integers only, so every tier reproduces the same bytes.
 */
import { sha256 } from '@noble/hashes/sha256';

export interface NutProps {
  /** centigrams: 500..2000 */
  massCg: number;
  /** centi-cm³: 200..1200 */
  volumeCcm3: number;
  /** 1..100 */
  hardness: number;
  /** percent: 20..80 */
  elasticityPct: number;
}

export interface StringProps {
  /** cm: 20..40 */
  lengthCm: number;
  /** newtons: 10..60 */
  strengthN: number;
  /** percent: 0..30 */
  elasticityPct: number;
}

export interface Conker {
  serial: number;
  /** hex of h0: links nut and string, seeds cosmetics */
  pairId: string;
  nut: NutProps;
  string: StringProps;
}

const CHAIN_LENGTH = 8;

export function hashChain(genesisSig: Uint8Array, serial: number): Uint8Array[] {
  if (!Number.isInteger(serial) || serial < 0 || serial > 0xffffffff) {
    throw new RangeError(`serial must be a uint32, got ${serial}`);
  }
  const seed = new Uint8Array(genesisSig.length + 4);
  seed.set(genesisSig, 0);
  new DataView(seed.buffer).setUint32(genesisSig.length, serial, false);
  const chain: Uint8Array[] = [sha256(seed)];
  for (let n = 1; n < CHAIN_LENGTH; n++) chain.push(sha256(chain[n - 1]!));
  return chain;
}

function u32(h: Uint8Array): number {
  return new DataView(h.buffer, h.byteOffset, 4).getUint32(0, false);
}

const hex = (b: Uint8Array): string => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');

export function deriveConker(genesisSig: Uint8Array, serial: number): Conker {
  const h = hashChain(genesisSig, serial);
  return {
    serial,
    pairId: hex(h[0]!),
    nut: {
      massCg: 500 + (u32(h[1]!) % 1501),
      volumeCcm3: 200 + (u32(h[2]!) % 1001),
      hardness: 1 + (u32(h[3]!) % 100),
      elasticityPct: 20 + (u32(h[4]!) % 61),
    },
    string: {
      lengthCm: 20 + (u32(h[5]!) % 21),
      strengthN: 10 + (u32(h[6]!) % 51),
      elasticityPct: u32(h[7]!) % 31,
    },
  };
}
