// conkers_cells — cell payload layouts, spec/cells.md. Port of mirror/src/cells.ts.
//
// Every Conkers cell is a Semantos cell: 256-byte header (cell-ops) + 768-byte
// payload (ours). Payloads are fixed-offset binary, little-endian integers,
// zero-padded. The field tables are the structs below: declaration order is
// byte order, offsets are derived by comptime reflection, never hand-written,
// exactly as cells.ts derives them from its tables. Field names are the spec's
// names (camelCase) so the three tiers and the JSON surface agree on them.
//
// Common prefix (8 bytes): "CNK", layout version (1), kind u16 LE, 2 reserved.

const std = @import("std");

pub const PAYLOAD_SIZE = 768;
pub const LAYOUT_VERSION: u8 = 1;
pub const PREFIX_SIZE = 8;
const MAGIC = "CNK";

pub const Payload = [PAYLOAD_SIZE]u8;

pub const Kind = enum(u16) { nut = 1, string = 2, player = 3, swing = 4, withdraw = 5, match = 6 };

// ── The six cell kinds ───────────────────────────────────────────────────────

pub const Nut = struct {
    pub const kind: Kind = .nut;
    /// purchase serial, the genesis input
    serial: u32,
    /// h0 = sha256(S || serial): links nut and string
    pairId: [32]u8,
    massCg: u16,
    volumeCcm3: u16,
    hardness: u8,
    elasticityPct: u8,
    /// 0..10000, minted at 10000, 0 = destroyed
    hp: u16,
    wins: u16,
    losses: u16,
    /// successor count, 0 at mint
    generation: u32,
    /// compressed secp256k1 pubkey
    owner: [33]u8,
    issuer: [33]u8,
    /// compact r||s RFC 6979 signature over CONKERS-GENESIS-v1
    genesisSig: [64]u8,
};

pub const String = struct {
    pub const kind: Kind = .string;
    serial: u32,
    pairId: [32]u8,
    lengthCm: u8,
    strengthN: u8,
    elasticityPct: u8,
    /// 1 intact, 0 snapped
    intact: u8,
    generation: u32,
    owner: [33]u8,
    issuer: [33]u8,
    genesisSig: [64]u8,
};

/// Keyed by the person (cert id), never by a conker.
pub const Player = struct {
    pub const kind: Kind = .player;
    certId: [32]u8,
    /// turns faced as target
    challenges: u32,
    /// turns withdrawn from as target
    withdrawals: u32,
    /// turns never swung as striker
    stalls: u32,
    matches: u32,
    wins: u32,
    lastMatchId: [32]u8,
};

pub const Swing = struct {
    pub const kind: Kind = .swing;
    /// the bytes a party signs end where this field starts
    pub const first_sig = "strikerSig";
    matchId: [32]u8,
    turn: u16,
    strikerCert: [32]u8,
    targetCert: [32]u8,
    imuSpeedCmps: u16,
    dopplerSpeedCmps: u16,
    planeDeg: u8,
    twistDegps: u16,
    timingMs: i16,
    followThrough: u8,
    scoreBp: u16,
    damageStriker: u16,
    damageTarget: u16,
    /// bit0 striker string snapped, bit1 target string snapped
    snapped: u8,
    timestamp: u64,
    strikerSig: [64]u8,
    targetSig: [64]u8,
};

pub const Withdraw = struct {
    pub const kind: Kind = .withdraw;
    pub const first_sig = "sigBy";
    matchId: [32]u8,
    turn: u16,
    /// 1 target withdrew, 2 striker stalled
    reason: u8,
    byCert: [32]u8,
    timestamp: u64,
    sigBy: [64]u8,
    sigOther: [64]u8,
    /// zero unless the arbiter ruled
    arbiterSig: [64]u8,
};

pub const Match = struct {
    pub const kind: Kind = .match;
    pub const first_sig = "sigA";
    matchId: [32]u8,
    nutA: [32]u8,
    stringA: [32]u8,
    nutB: [32]u8,
    stringB: [32]u8,
    certA: [32]u8,
    certB: [32]u8,
    nonceA: u32,
    nonceB: u32,
    /// number of swing + withdraw cells
    turns: u16,
    turnsRoot: [32]u8,
    hpA: u16,
    hpB: u16,
    intactA: u8,
    intactB: u8,
    /// 0 draw, 1 A, 2 B
    winner: u8,
    startedAt: u64,
    endedAt: u64,
    sigA: [64]u8,
    sigB: [64]u8,
    arbiterSig: [64]u8,
};

// ── Layout derivation ────────────────────────────────────────────────────────

fn fieldSize(comptime T: type) usize {
    return switch (@typeInfo(T)) {
        .int => @sizeOf(T),
        .array => |a| a.len,
        else => @compileError("cell fields are integers or byte arrays"),
    };
}

/// Total payload bytes used by `T`, prefix included.
pub fn sizeOf(comptime T: type) usize {
    return comptime blk: {
        var at: usize = PREFIX_SIZE;
        for (@typeInfo(T).@"struct".fields) |f| at += fieldSize(f.type);
        if (at > PAYLOAD_SIZE) @compileError(@typeName(T) ++ " layout exceeds the payload");
        break :blk at;
    };
}

pub fn offsetOf(comptime T: type, comptime name: []const u8) usize {
    return comptime blk: {
        var at: usize = PREFIX_SIZE;
        for (@typeInfo(T).@"struct".fields) |f| {
            if (std.mem.eql(u8, f.name, name)) break :blk at;
            at += fieldSize(f.type);
        }
        @compileError(@typeName(T) ++ " has no field " ++ name);
    };
}

/// The byte before the first signature field; the whole record when unsigned.
pub fn signedEnd(comptime T: type) usize {
    return if (@hasDecl(T, "first_sig")) offsetOf(T, T.first_sig) else sizeOf(T);
}

pub fn encode(v: anytype) Payload {
    const T = @TypeOf(v);
    var out: Payload = [_]u8{0} ** PAYLOAD_SIZE;
    out[0..3].* = MAGIC.*;
    out[3] = LAYOUT_VERSION;
    std.mem.writeInt(u16, out[4..6], @intFromEnum(T.kind), .little);
    comptime var at: usize = PREFIX_SIZE;
    inline for (@typeInfo(T).@"struct".fields) |f| {
        const val = @field(v, f.name);
        switch (@typeInfo(f.type)) {
            .int => std.mem.writeInt(f.type, out[at..][0..@sizeOf(f.type)], val, .little),
            .array => |a| out[at..][0..a.len].* = val,
            else => unreachable,
        }
        at += comptime fieldSize(f.type);
    }
    return out;
}

pub const DecodeError = error{ WrongPayloadSize, NotAConkersCell, UnsupportedLayout, UnknownKind, WrongKind };

pub fn kindOf(payload: []const u8) DecodeError!Kind {
    if (payload.len != PAYLOAD_SIZE) return error.WrongPayloadSize;
    if (!std.mem.eql(u8, payload[0..3], MAGIC)) return error.NotAConkersCell;
    if (payload[3] != LAYOUT_VERSION) return error.UnsupportedLayout;
    const raw = std.mem.readInt(u16, payload[4..6], .little);
    inline for (@typeInfo(Kind).@"enum".fields) |f| if (raw == f.value) return @enumFromInt(raw);
    return error.UnknownKind;
}

pub fn decode(comptime T: type, payload: []const u8) DecodeError!T {
    if (try kindOf(payload) != T.kind) return error.WrongKind;
    var v: T = undefined;
    comptime var at: usize = PREFIX_SIZE;
    inline for (@typeInfo(T).@"struct".fields) |f| {
        switch (@typeInfo(f.type)) {
            .int => @field(v, f.name) = std.mem.readInt(f.type, payload[at..][0..@sizeOf(f.type)], .little),
            .array => |a| @field(v, f.name) = payload[at..][0..a.len].*,
            else => unreachable,
        }
        at += comptime fieldSize(f.type);
    }
    return v;
}

/// The bytes a party signs: prefix + every field before the first *Sig field.
pub fn signedBytes(comptime T: type, payload: []const u8) []const u8 {
    return payload[0..signedEnd(T)];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const testing = std.testing;

test "offsets agree with the generated spec/cells.md" {
    // A few pins straight from the spec tables; the rest follow by construction.
    try testing.expectEqual(@as(usize, 60), offsetOf(Nut, "owner"));
    try testing.expectEqual(@as(usize, 126), offsetOf(Nut, "genesisSig"));
    try testing.expectEqual(@as(usize, 190), sizeOf(Nut));
    try testing.expectEqual(@as(usize, 118), offsetOf(String, "genesisSig"));
    try testing.expectEqual(@as(usize, 60), offsetOf(Player, "lastMatchId"));
    try testing.expectEqual(@as(usize, 131), signedEnd(Swing));
    try testing.expectEqual(@as(usize, 83), signedEnd(Withdraw));
    try testing.expectEqual(@as(usize, 297), signedEnd(Match));
    try testing.expectEqual(sizeOf(Nut), signedEnd(Nut));
}

test "encode/decode round-trips and the prefix is CNK v1 kind" {
    const n = Nut{ .serial = 7, .pairId = [_]u8{1} ** 32, .massCg = 1234, .volumeCcm3 = 567, .hardness = 42, .elasticityPct = 50, .hp = 10000, .wins = 1, .losses = 2, .generation = 3, .owner = [_]u8{2} ** 33, .issuer = [_]u8{3} ** 33, .genesisSig = [_]u8{4} ** 64 };
    const p = encode(n);
    try testing.expectEqualSlices(u8, "CNK\x01\x01\x00\x00\x00", p[0..8]);
    try testing.expectEqual(Kind.nut, try kindOf(&p));
    try testing.expectEqual(n, try decode(Nut, &p));
    try testing.expectError(error.WrongKind, decode(String, &p));
    try testing.expectError(error.WrongPayloadSize, decode(Nut, p[0..100]));
}

test "signed bytes stop before the first signature" {
    const s = Swing{ .matchId = [_]u8{9} ** 32, .turn = 1, .strikerCert = [_]u8{0} ** 32, .targetCert = [_]u8{0} ** 32, .imuSpeedCmps = 300, .dopplerSpeedCmps = 300, .planeDeg = 0, .twistDegps = 0, .timingMs = -5, .followThrough = 1, .scoreBp = 10000, .damageStriker = 1, .damageTarget = 2, .snapped = 0, .timestamp = 123, .strikerSig = [_]u8{0xaa} ** 64, .targetSig = [_]u8{0xbb} ** 64 };
    const p = encode(s);
    const sb = signedBytes(Swing, &p);
    try testing.expectEqual(@as(usize, 131), sb.len);
    try testing.expectEqual(@as(u8, 0xaa), p[131]);
    try testing.expectEqual(@as(i16, -5), (try decode(Swing, &p)).timingMs);
}
