# Cell payloads

Generated from `mirror/src/cells.ts` by `pnpm --filter @conkers/mirror doc:cells`. Do not edit by hand.

Every Conkers cell is a Semantos cell: a 256-byte header built by `@semantos/cell-ops`
`buildCellHeader` (linearity, typeHash, ownerId, timestamp) and a 768-byte payload
owned by this spec. Payloads are fixed-offset binary, little-endian, zero-padded.

Common prefix: bytes 0..2 are `CNK`, byte 3 is the layout version (1), bytes 4..5 the kind
(u16), bytes 6..7 reserved. Fields start at offset 8.

Signatures are over `signedBytes`: the prefix plus every field before the first `*Sig` field.
A cell with no signature field is signed as a whole by its header's owner.

## Layouts

### conkers.nut (kind 1, 190 of 768 bytes, signed bytes [0..190))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 4 | `serial` u32 | purchase serial, the genesis input |
| 12 | 32 | `pairId` bytes | h0 = sha256(S || serial): links nut and string |
| 44 | 2 | `massCg` u16 | centigrams 500..2000 |
| 46 | 2 | `volumeCcm3` u16 | centi-cm³ 200..1200 |
| 48 | 1 | `hardness` u8 | 1..100 |
| 49 | 1 | `elasticityPct` u8 | 20..80 |
| 50 | 2 | `hp` u16 | 0..10000, minted at 10000, 0 = destroyed |
| 52 | 2 | `wins` u16 | matches this nut won |
| 54 | 2 | `losses` u16 | matches this nut lost |
| 56 | 4 | `generation` u32 | successor count, 0 at mint |
| 60 | 33 | `owner` bytes | compressed secp256k1 pubkey |
| 93 | 33 | `issuer` bytes | issuer pubkey the genesis signature verifies under |
| 126 | 64 | `genesisSig` bytes | compact r||s RFC 6979 signature over CONKERS-GENESIS-v1 |

### conkers.string (kind 2, 182 of 768 bytes, signed bytes [0..182))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 4 | `serial` u32 | same serial as the nut |
| 12 | 32 | `pairId` bytes | same h0 as the nut |
| 44 | 1 | `lengthCm` u8 | 20..40 |
| 45 | 1 | `strengthN` u8 | 10..60 |
| 46 | 1 | `elasticityPct` u8 | 0..30 |
| 47 | 1 | `intact` u8 | 1 intact, 0 snapped |
| 48 | 4 | `generation` u32 | successor count, 0 at mint |
| 52 | 33 | `owner` bytes | compressed secp256k1 pubkey |
| 85 | 33 | `issuer` bytes | issuer pubkey |
| 118 | 64 | `genesisSig` bytes | compact signature, same as the nut |

### conkers.player (kind 3, 92 of 768 bytes, signed bytes [0..92))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 32 | `certId` bytes | the person, by BRC-52 cert id; never a conker |
| 40 | 4 | `challenges` u32 | turns faced as target |
| 44 | 4 | `withdrawals` u32 | turns withdrawn from as target |
| 48 | 4 | `stalls` u32 | turns never swung as striker |
| 52 | 4 | `matches` u32 | matches completed |
| 56 | 4 | `wins` u32 | matches won |
| 60 | 32 | `lastMatchId` bytes | most recent conkers.match cell hash |

### conkers.swing (kind 4, 259 of 768 bytes, signed bytes [0..131))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 32 | `matchId` bytes | the match this turn belongs to |
| 40 | 2 | `turn` u16 | turn index, 0-based |
| 42 | 32 | `strikerCert` bytes | who swung |
| 74 | 32 | `targetCert` bytes | who held |
| 106 | 2 | `imuSpeedCmps` u16 | striker IMU speed at impact, cm/s |
| 108 | 2 | `dopplerSpeedCmps` u16 | target Doppler radial speed, cm/s |
| 110 | 1 | `planeDeg` u8 | gravity vs swing plane, degrees |
| 111 | 2 | `twistDegps` u16 | peak gyro roll, deg/s |
| 113 | 2 | `timingMs` i16 | impact minus target rest, ms |
| 115 | 1 | `followThrough` u8 | 1 decelerated after impact, 0 braked before |
| 116 | 2 | `scoreBp` u16 | swing score, basis points 0..10000 |
| 118 | 2 | `damageStriker` u16 | hp lost by the striker nut |
| 120 | 2 | `damageTarget` u16 | hp lost by the target nut |
| 122 | 1 | `snapped` u8 | bit0 striker string snapped, bit1 target string snapped |
| 123 | 8 | `timestamp` u64 | unix ms at impact, striker clock |
| 131 | 64 | `strikerSig` bytes | striker signature over bytes [0..timestamp end) |
| 195 | 64 | `targetSig` bytes | target signature over the same bytes |

### conkers.withdraw (kind 5, 275 of 768 bytes, signed bytes [0..83))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 32 | `matchId` bytes | the match |
| 40 | 2 | `turn` u16 | turn index |
| 42 | 1 | `reason` u8 | 1 target withdrew, 2 striker stalled |
| 43 | 32 | `byCert` bytes | whose record this lands on |
| 75 | 8 | `timestamp` u64 | unix ms |
| 83 | 64 | `sigBy` bytes | signature of the party it counts against |
| 147 | 64 | `sigOther` bytes | the other party |
| 211 | 64 | `arbiterSig` bytes | zero unless the arbiter ruled |

### conkers.match (kind 6, 489 of 768 bytes, signed bytes [0..297))

| offset | size | field | meaning |
|---|---|---|---|
| 8 | 32 | `matchId` bytes | sha256(nutA || nutB || nonceA || nonceB) |
| 40 | 32 | `nutA` bytes | cell hash consumed |
| 72 | 32 | `stringA` bytes | cell hash consumed |
| 104 | 32 | `nutB` bytes | cell hash consumed |
| 136 | 32 | `stringB` bytes | cell hash consumed |
| 168 | 32 | `certA` bytes | player A |
| 200 | 32 | `certB` bytes | player B |
| 232 | 4 | `nonceA` u32 | sent by A over ggwave, heard and signed by B |
| 236 | 4 | `nonceB` u32 | sent by B over ggwave, heard and signed by A |
| 240 | 2 | `turns` u16 | number of swing + withdraw cells |
| 242 | 32 | `turnsRoot` bytes | sha256 chain over the turn cells in order |
| 274 | 2 | `hpA` u16 | nut A hp after the match |
| 276 | 2 | `hpB` u16 | nut B hp after the match |
| 278 | 1 | `intactA` u8 | string A intact after the match |
| 279 | 1 | `intactB` u8 | string B intact after the match |
| 280 | 1 | `winner` u8 | 0 draw, 1 A, 2 B |
| 281 | 8 | `startedAt` u64 | unix ms |
| 289 | 8 | `endedAt` u64 | unix ms |
| 297 | 64 | `sigA` bytes | A over bytes [0..endedAt end) |
| 361 | 64 | `sigB` bytes | B over the same bytes |
| 425 | 64 | `arbiterSig` bytes | arbiter over the same bytes |
