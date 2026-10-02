import { describe, expect, it } from 'vitest';
import { CellKind, LAYOUTS, PAYLOAD_SIZE, decodeCell, encodeCell, kindOf, layout, signedBytes, type CellKindName, type Record_ } from '../cells.js';

const bytes = (n: number, fill = 0xaa) => new Uint8Array(n).fill(fill);
function sample(kind: CellKindName): Record_ {
  const v: Record_ = {};
  for (const f of LAYOUTS[kind]) {
    if (typeof f.type === 'object') v[f.name] = bytes(f.type.bytes, f.type.bytes & 0xff);
    else if (f.type === 'u64') v[f.name] = 1_700_000_000_123n;
    else if (f.type === 'i16') v[f.name] = -42;
    else if (f.type === 'u8') v[f.name] = 7;
    else if (f.type === 'u16') v[f.name] = 10000;
    else v[f.name] = 123456;
  }
  return v;
}
const kinds = Object.keys(LAYOUTS) as CellKindName[];

describe('cell payloads', () => {
  it.each(kinds)('%s fits the 768-byte payload and round-trips', (kind) => {
    expect(layout(kind).size).toBeLessThanOrEqual(PAYLOAD_SIZE);
    const v = sample(kind);
    const p = encodeCell(kind, v);
    expect(p).toHaveLength(PAYLOAD_SIZE);
    expect(kindOf(p)).toBe(kind);
    expect(decodeCell(kind, p)).toEqual(v);
  });
  it('is zero-padded after the last field', () => {
    const p = encodeCell('player', sample('player'));
    expect(p.slice(layout('player').size).every((b) => b === 0)).toBe(true);
  });
  it('signed bytes stop before the first signature field', () => {
    const { offsets, signedEnd } = layout('swing');
    expect(signedEnd).toBe(offsets['strikerSig']);
    expect(signedBytes('swing', encodeCell('swing', sample('swing')))).toHaveLength(signedEnd);
    expect(layout('player').signedEnd).toBe(layout('player').size);
  });
  it('rejects out-of-range and wrong-size values', () => {
    expect(() => encodeCell('nut', { ...sample('nut'), hp: 70000 })).toThrow(RangeError);
    expect(() => encodeCell('nut', { ...sample('nut'), owner: bytes(32) })).toThrow(RangeError);
    expect(() => encodeCell('swing', { ...sample('swing'), timingMs: 40000 })).toThrow(RangeError);
  });
  it('rejects foreign bytes and kind mismatch', () => {
    expect(() => kindOf(new Uint8Array(PAYLOAD_SIZE))).toThrow(/not a Conkers cell/);
    expect(() => decodeCell('nut', encodeCell('string', sample('string')))).toThrow(/expected nut/);
  });
  it('kind ids are stable', () => {
    expect(CellKind).toEqual({ nut: 1, string: 2, player: 3, swing: 4, withdraw: 5, match: 6 });
  });
});
