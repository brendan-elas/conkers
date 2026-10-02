/**
 * Cell payload layouts — spec/cells.md.
 *
 * Every Conkers cell is a Semantos cell: 256-byte header (owned by cell-ops,
 * `buildCellHeader`) + 768-byte payload (ours). Payloads are fixed-offset
 * binary, little-endian integers, zero-padded, so the Zig brain and the TS
 * mirror read the same bytes without a JSON parser in the handler.
 *
 * Common prefix (8 bytes):
 *   [0..2] "CNK"   [3] layout version (1)   [4..5] kind u16   [6..7] reserved
 */

export const PAYLOAD_SIZE = 768;
export const LAYOUT_VERSION = 1;
const MAGIC = [0x43, 0x4e, 0x4b] as const; // "CNK"

export const CellKind = {
  nut: 1,
  string: 2,
  player: 3,
  swing: 4,
  withdraw: 5,
  match: 6,
} as const;
export type CellKindName = keyof typeof CellKind;

type FieldType = 'u8' | 'u16' | 'u32' | 'u64' | 'i16' | { bytes: number };
export interface Field { readonly name: string; readonly type: FieldType; readonly doc: string; /** a party's signature over the bytes before it */ readonly sig?: boolean }

function size(t: FieldType): number {
  if (typeof t === 'object') return t.bytes;
  return { u8: 1, u16: 2, u32: 4, u64: 8, i16: 2 }[t];
}

/** Field tables. Order is byte order; offsets are derived, never hand-written. */
export const LAYOUTS: Record<CellKindName, readonly Field[]> = {
  nut: [
    { name: 'serial', type: 'u32', doc: 'purchase serial, the genesis input' },
    { name: 'pairId', type: { bytes: 32 }, doc: 'h0 = sha256(S || serial): links nut and string' },
    { name: 'massCg', type: 'u16', doc: 'centigrams 500..2000' },
    { name: 'volumeCcm3', type: 'u16', doc: 'centi-cm³ 200..1200' },
    { name: 'hardness', type: 'u8', doc: '1..100' },
    { name: 'elasticityPct', type: 'u8', doc: '20..80' },
    { name: 'hp', type: 'u16', doc: '0..10000, minted at 10000, 0 = destroyed' },
    { name: 'wins', type: 'u16', doc: 'matches this nut won' },
    { name: 'losses', type: 'u16', doc: 'matches this nut lost' },
    { name: 'generation', type: 'u32', doc: 'successor count, 0 at mint' },
    { name: 'owner', type: { bytes: 33 }, doc: 'compressed secp256k1 pubkey' },
    { name: 'issuer', type: { bytes: 33 }, doc: 'issuer pubkey the genesis signature verifies under' },
    { name: 'genesisSig', type: { bytes: 64 }, doc: 'compact r||s RFC 6979 signature over CONKERS-GENESIS-v1' },
  ],
  string: [
    { name: 'serial', type: 'u32', doc: 'same serial as the nut' },
    { name: 'pairId', type: { bytes: 32 }, doc: 'same h0 as the nut' },
    { name: 'lengthCm', type: 'u8', doc: '20..40' },
    { name: 'strengthN', type: 'u8', doc: '10..60' },
    { name: 'elasticityPct', type: 'u8', doc: '0..30' },
    { name: 'intact', type: 'u8', doc: '1 intact, 0 snapped' },
    { name: 'generation', type: 'u32', doc: 'successor count, 0 at mint' },
    { name: 'owner', type: { bytes: 33 }, doc: 'compressed secp256k1 pubkey' },
    { name: 'issuer', type: { bytes: 33 }, doc: 'issuer pubkey' },
    { name: 'genesisSig', type: { bytes: 64 }, doc: 'compact signature, same as the nut' },
  ],
  player: [
    { name: 'certId', type: { bytes: 32 }, doc: 'the person, by BRC-52 cert id; never a conker' },
    { name: 'challenges', type: 'u32', doc: 'turns faced as target' },
    { name: 'withdrawals', type: 'u32', doc: 'turns withdrawn from as target' },
    { name: 'stalls', type: 'u32', doc: 'turns never swung as striker' },
    { name: 'matches', type: 'u32', doc: 'matches completed' },
    { name: 'wins', type: 'u32', doc: 'matches won' },
    { name: 'lastMatchId', type: { bytes: 32 }, doc: 'most recent conkers.match cell hash' },
  ],
  swing: [
    { name: 'matchId', type: { bytes: 32 }, doc: 'the match this turn belongs to' },
    { name: 'turn', type: 'u16', doc: 'turn index, 0-based' },
    { name: 'strikerCert', type: { bytes: 32 }, doc: 'who swung' },
    { name: 'targetCert', type: { bytes: 32 }, doc: 'who held' },
    { name: 'imuSpeedCmps', type: 'u16', doc: 'striker IMU speed at impact, cm/s' },
    { name: 'dopplerSpeedCmps', type: 'u16', doc: 'target Doppler radial speed, cm/s' },
    { name: 'planeDeg', type: 'u8', doc: 'gravity vs swing plane, degrees' },
    { name: 'twistDegps', type: 'u16', doc: 'peak gyro roll, deg/s' },
    { name: 'timingMs', type: 'i16', doc: 'impact minus target rest, ms' },
    { name: 'followThrough', type: 'u8', doc: '1 decelerated after impact, 0 braked before' },
    { name: 'scoreBp', type: 'u16', doc: 'swing score, basis points 0..10000' },
    { name: 'damageStriker', type: 'u16', doc: 'hp lost by the striker nut' },
    { name: 'damageTarget', type: 'u16', doc: 'hp lost by the target nut' },
    { name: 'snapped', type: 'u8', doc: 'bit0 striker string snapped, bit1 target string snapped' },
    { name: 'timestamp', type: 'u64', doc: 'unix ms at impact, striker clock' },
    { name: 'strikerSig', type: { bytes: 64 }, sig: true, doc: 'striker signature over bytes [0..timestamp end)' },
    { name: 'targetSig', type: { bytes: 64 }, sig: true, doc: 'target signature over the same bytes' },
  ],
  withdraw: [
    { name: 'matchId', type: { bytes: 32 }, doc: 'the match' },
    { name: 'turn', type: 'u16', doc: 'turn index' },
    { name: 'reason', type: 'u8', doc: '1 target withdrew, 2 striker stalled' },
    { name: 'byCert', type: { bytes: 32 }, doc: 'whose record this lands on' },
    { name: 'timestamp', type: 'u64', doc: 'unix ms' },
    { name: 'sigBy', type: { bytes: 64 }, sig: true, doc: 'signature of the party it counts against' },
    { name: 'sigOther', type: { bytes: 64 }, sig: true, doc: 'the other party' },
    { name: 'arbiterSig', type: { bytes: 64 }, sig: true, doc: 'zero unless the arbiter ruled' },
  ],
  match: [
    { name: 'matchId', type: { bytes: 32 }, doc: 'sha256(nutA || nutB || nonceA || nonceB)' },
    { name: 'nutA', type: { bytes: 32 }, doc: 'cell hash consumed' },
    { name: 'stringA', type: { bytes: 32 }, doc: 'cell hash consumed' },
    { name: 'nutB', type: { bytes: 32 }, doc: 'cell hash consumed' },
    { name: 'stringB', type: { bytes: 32 }, doc: 'cell hash consumed' },
    { name: 'certA', type: { bytes: 32 }, doc: 'player A' },
    { name: 'certB', type: { bytes: 32 }, doc: 'player B' },
    { name: 'nonceA', type: 'u32', doc: 'sent by A over ggwave, heard and signed by B' },
    { name: 'nonceB', type: 'u32', doc: 'sent by B over ggwave, heard and signed by A' },
    { name: 'turns', type: 'u16', doc: 'number of swing + withdraw cells' },
    { name: 'turnsRoot', type: { bytes: 32 }, doc: 'sha256 chain over the turn cells in order' },
    { name: 'hpA', type: 'u16', doc: 'nut A hp after the match' },
    { name: 'hpB', type: 'u16', doc: 'nut B hp after the match' },
    { name: 'intactA', type: 'u8', doc: 'string A intact after the match' },
    { name: 'intactB', type: 'u8', doc: 'string B intact after the match' },
    { name: 'winner', type: 'u8', doc: '0 draw, 1 A, 2 B' },
    { name: 'startedAt', type: 'u64', doc: 'unix ms' },
    { name: 'endedAt', type: 'u64', doc: 'unix ms' },
    { name: 'sigA', type: { bytes: 64 }, sig: true, doc: 'A over bytes [0..endedAt end)' },
    { name: 'sigB', type: { bytes: 64 }, sig: true, doc: 'B over the same bytes' },
    { name: 'arbiterSig', type: { bytes: 64 }, sig: true, doc: 'arbiter over the same bytes' },
  ],
};

export const PREFIX_SIZE = 8;

export interface LayoutInfo { readonly offsets: Record<string, number>; readonly signedEnd: number; readonly size: number }

/** Offsets for a kind. `signedEnd` is the byte before the first signature field. */
export function layout(kind: CellKindName): LayoutInfo {
  const offsets: Record<string, number> = {};
  let at = PREFIX_SIZE; let signedEnd = -1;
  for (const f of LAYOUTS[kind]) {
    if (signedEnd < 0 && f.sig) signedEnd = at;
    offsets[f.name] = at; at += size(f.type);
  }
  if (at > PAYLOAD_SIZE) throw new Error(`${kind} layout is ${at} bytes, over ${PAYLOAD_SIZE}`);
  return { offsets, signedEnd: signedEnd < 0 ? at : signedEnd, size: at };
}

export type Value = number | bigint | Uint8Array;
export type Record_ = Record<string, Value>;

export function encodeCell(kind: CellKindName, values: Record_): Uint8Array {
  const out = new Uint8Array(PAYLOAD_SIZE);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0); out[3] = LAYOUT_VERSION; dv.setUint16(4, CellKind[kind], true);
  const { offsets } = layout(kind);
  for (const f of LAYOUTS[kind]) {
    const v = values[f.name]; const o = offsets[f.name]!;
    if (v === undefined) throw new Error(`${kind}.${f.name} missing`);
    if (typeof f.type === 'object') {
      if (!(v instanceof Uint8Array) || v.length !== f.type.bytes) throw new RangeError(`${kind}.${f.name} must be ${f.type.bytes} bytes`);
      out.set(v, o); continue;
    }
    if (f.type === 'u64') { dv.setBigUint64(o, BigInt(v as number | bigint), true); continue; }
    const n = Number(v);
    if (!Number.isInteger(n)) throw new RangeError(`${kind}.${f.name} must be an integer`);
    const lim: Record<string, [number, number]> = { u8: [0, 0xff], u16: [0, 0xffff], u32: [0, 0xffffffff], i16: [-0x8000, 0x7fff] };
    const [lo, hi] = lim[f.type]!;
    if (n < lo || n > hi) throw new RangeError(`${kind}.${f.name}=${n} outside ${f.type}`);
    if (f.type === 'u8') dv.setUint8(o, n);
    else if (f.type === 'u16') dv.setUint16(o, n, true);
    else if (f.type === 'u32') dv.setUint32(o, n, true);
    else dv.setInt16(o, n, true);
  }
  return out;
}

export function kindOf(payload: Uint8Array): CellKindName {
  if (payload.length !== PAYLOAD_SIZE) throw new RangeError(`payload must be ${PAYLOAD_SIZE} bytes`);
  if (payload[0] !== MAGIC[0] || payload[1] !== MAGIC[1] || payload[2] !== MAGIC[2]) throw new Error('not a Conkers cell');
  if (payload[3] !== LAYOUT_VERSION) throw new Error(`layout version ${payload[3]} unsupported`);
  const k = new DataView(payload.buffer, payload.byteOffset).getUint16(4, true);
  const name = (Object.keys(CellKind) as CellKindName[]).find((n) => CellKind[n] === k);
  if (!name) throw new Error(`unknown cell kind ${k}`);
  return name;
}

export function decodeCell<K extends CellKindName>(kind: K, payload: Uint8Array): Record_ {
  const actual = kindOf(payload);
  if (actual !== kind) throw new Error(`expected ${kind}, got ${actual}`);
  const dv = new DataView(payload.buffer, payload.byteOffset);
  const { offsets } = layout(kind); const out: Record_ = {};
  for (const f of LAYOUTS[kind]) {
    const o = offsets[f.name]!;
    if (typeof f.type === 'object') out[f.name] = payload.slice(o, o + f.type.bytes);
    else if (f.type === 'u8') out[f.name] = dv.getUint8(o);
    else if (f.type === 'u16') out[f.name] = dv.getUint16(o, true);
    else if (f.type === 'u32') out[f.name] = dv.getUint32(o, true);
    else if (f.type === 'i16') out[f.name] = dv.getInt16(o, true);
    else out[f.name] = dv.getBigUint64(o, true);
  }
  return out;
}

/** The bytes a party signs: prefix + every field before the first *Sig field. */
export function signedBytes(kind: CellKindName, payload: Uint8Array): Uint8Array {
  return payload.slice(0, layout(kind).signedEnd);
}

/** Markdown for spec/cells.md, so the doc is generated from the tables, never typed. */
export function renderLayoutDoc(): string {
  const lines: string[] = [];
  for (const kind of Object.keys(LAYOUTS) as CellKindName[]) {
    const { offsets, size: total, signedEnd } = layout(kind);
    lines.push(`### conkers.${kind} (kind ${CellKind[kind]}, ${total} of ${PAYLOAD_SIZE} bytes, signed bytes [0..${signedEnd}))`, '', '| offset | size | field | meaning |', '|---|---|---|---|');
    for (const f of LAYOUTS[kind]) lines.push(`| ${offsets[f.name]} | ${size(f.type)} | \`${f.name}\` ${typeof f.type === 'object' ? 'bytes' : f.type} | ${f.doc} |`);
    lines.push('');
  }
  return lines.join('\n');
}
