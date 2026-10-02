import { describe, expect, it } from 'vitest';
import { deriveConker, hashChain } from '../derive.js';

const S = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff);

describe('deriveConker', () => {
  it('is deterministic', () => {
    expect(deriveConker(S, 1)).toEqual(deriveConker(S, 1));
    expect(deriveConker(S, 1)).not.toEqual(deriveConker(S, 2));
  });
  it('chains 8 hashes and uses h0 as the pair id', () => {
    const chain = hashChain(S, 7);
    expect(chain).toHaveLength(8);
    expect(deriveConker(S, 7).pairId).toHaveLength(64);
  });
  it('keeps every property inside its spec range over 2000 serials', () => {
    for (let serial = 0; serial < 2000; serial++) {
      const c = deriveConker(S, serial);
      expect(c.nut.massCg).toBeGreaterThanOrEqual(500); expect(c.nut.massCg).toBeLessThanOrEqual(2000);
      expect(c.nut.volumeCcm3).toBeGreaterThanOrEqual(200); expect(c.nut.volumeCcm3).toBeLessThanOrEqual(1200);
      expect(c.nut.hardness).toBeGreaterThanOrEqual(1); expect(c.nut.hardness).toBeLessThanOrEqual(100);
      expect(c.nut.elasticityPct).toBeGreaterThanOrEqual(20); expect(c.nut.elasticityPct).toBeLessThanOrEqual(80);
      expect(c.string.lengthCm).toBeGreaterThanOrEqual(20); expect(c.string.lengthCm).toBeLessThanOrEqual(40);
      expect(c.string.strengthN).toBeGreaterThanOrEqual(10); expect(c.string.strengthN).toBeLessThanOrEqual(60);
      expect(c.string.elasticityPct).toBeGreaterThanOrEqual(0); expect(c.string.elasticityPct).toBeLessThanOrEqual(30);
    }
  });
  it('rejects a non-uint32 serial', () => {
    expect(() => deriveConker(S, -1)).toThrow(RangeError);
    expect(() => deriveConker(S, 2 ** 32)).toThrow(RangeError);
  });
});
