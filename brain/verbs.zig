// conkers_verbs — the cartridge verbs as pure functions over cell payloads.
// Port of mirror/src/verbs.ts, byte for byte (spec/vectors.json, vectors_test.zig).
//
//   mintPair       issuer-side: two payloads + the lock script for a serial
//   verifyGenesis  anyone: recompute the props and check the issuer signature
//   resolveMatch   consume 2 nuts + 2 strings + a signed match + its turns →
//                  successor nuts/strings and updated player records
//   transferPair   owner-side: new owner on both cells
//
// Signatures in cell fields are 64-byte compact ECDSA over sha256(signedBytes).
// certId is sha256(ownerPubKey) in this reference; production substitutes the
// BRC-52 cert id the world host puts on the socket. Nothing here signs: the
// brain verifies, phones and the issuer sign.

const std = @import("std");
const derive = @import("conkers_derive");
const cells = @import("conkers_cells");
const physics = @import("conkers_physics");
const script = @import("conkers_script");
const Sha256 = std.crypto.hash.sha2.Sha256;
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;

pub const GENESIS_MESSAGE = "CONKERS-GENESIS-v1";
const Z32 = [_]u8{0} ** 32;
const Z64 = [_]u8{0} ** 64;

pub fn sha256(data: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    Sha256.hash(data, &out, .{});
    return out;
}
pub fn certIdOf(pubkey: [33]u8) [32]u8 {
    return sha256(&pubkey);
}
pub fn cellRef(payload: []const u8) [32]u8 {
    return sha256(payload);
}
inline fn eq(a: anytype, b: @TypeOf(a)) bool {
    return std.mem.eql(u8, &a, &b);
}

/// Compact r||s over sha256(bytes). The verifier hashes `bytes` itself; a zero or
/// malformed signature or key is simply false, as in the mirror.
pub fn verifyField(sig: [64]u8, bytes: []const u8, pubkey: [33]u8) bool {
    const pk = Ecdsa.PublicKey.fromSec1(&pubkey) catch return false;
    Ecdsa.Signature.fromBytes(sig).verify(bytes, pk) catch return false;
    return true;
}

// ── mint ─────────────────────────────────────────────────────────────────────

pub const MintParams = struct { genesisSig: [64]u8, issuerPub: [33]u8, serial: u32, ownerPub: [33]u8, mintLocktime: u32 };
pub const MintedPair = struct { conker: derive.Conker, nut: cells.Payload, string: cells.Payload, lock: script.Script };
pub const MintError = error{GenesisSignatureInvalid};

pub fn mintPair(p: MintParams) MintError!MintedPair {
    if (!verifyField(p.genesisSig, GENESIS_MESSAGE, p.issuerPub)) return error.GenesisSignatureInvalid;
    const c = derive.deriveConker(p.genesisSig, p.serial);
    const nut = cells.encode(cells.Nut{
        .serial = c.serial, .pairId = c.pairId,
        .massCg = c.nut.massCg, .volumeCcm3 = c.nut.volumeCcm3, .hardness = c.nut.hardness, .elasticityPct = c.nut.elasticityPct,
        .hp = physics.HP_MAX, .wins = 0, .losses = 0, .generation = 0,
        .owner = p.ownerPub, .issuer = p.issuerPub, .genesisSig = p.genesisSig,
    });
    const string = cells.encode(cells.String{
        .serial = c.serial, .pairId = c.pairId,
        .lengthCm = c.string.lengthCm, .strengthN = c.string.strengthN, .elasticityPct = c.string.elasticityPct,
        .intact = 1, .generation = 0,
        .owner = p.ownerPub, .issuer = p.issuerPub, .genesisSig = p.genesisSig,
    });
    return .{ .conker = c, .nut = nut, .string = string, .lock = script.conkerLock(script.hash160(&p.ownerPub), p.mintLocktime) };
}

// ── verifyGenesis ────────────────────────────────────────────────────────────

pub const GenesisError = cells.DecodeError || error{ GenesisSignatureInvalid, PairIdMismatch, PropsForged };

/// Fails if the payload's props are not what its genesis signature and serial derive.
pub fn verifyGenesis(comptime T: type, payload: []const u8) GenesisError!T {
    const r = try cells.decode(T, payload);
    if (!verifyField(r.genesisSig, GENESIS_MESSAGE, r.issuer)) return error.GenesisSignatureInvalid;
    const c = derive.deriveConker(r.genesisSig, r.serial);
    if (!eq(r.pairId, c.pairId)) return error.PairIdMismatch;
    const ok = if (T == cells.Nut)
        r.massCg == c.nut.massCg and r.volumeCcm3 == c.nut.volumeCcm3 and r.hardness == c.nut.hardness and r.elasticityPct == c.nut.elasticityPct
    else
        r.lengthCm == c.string.lengthCm and r.strengthN == c.string.strengthN and r.elasticityPct == c.string.elasticityPct;
    if (!ok) return error.PropsForged;
    return r;
}

fn stateOf(n: cells.Nut, s: cells.String) physics.ConkerState {
    return .{
        .nut = .{ .massCg = n.massCg, .volumeCcm3 = n.volumeCcm3, .hardness = n.hardness, .elasticityPct = n.elasticityPct },
        .string = .{ .lengthCm = s.lengthCm, .strengthN = s.strengthN, .elasticityPct = s.elasticityPct },
        .hp = n.hp,
        .intact = s.intact == 1,
    };
}

/// sha256 chain over the turn payloads, in order, from a zero root.
pub fn turnsRoot(turns: []const []const u8) [32]u8 {
    var root = Z32;
    for (turns) |t| {
        var buf: [64]u8 = undefined;
        buf[0..32].* = root;
        buf[32..64].* = cellRef(t);
        root = sha256(&buf);
    }
    return root;
}

// ── resolveMatch ─────────────────────────────────────────────────────────────

pub const ResolveInput = struct {
    nutA: []const u8,
    stringA: []const u8,
    nutB: []const u8,
    stringB: []const u8,
    match: []const u8,
    turns: []const []const u8,
    arbiterPub: [33]u8,
    playerA: ?[]const u8 = null,
    playerB: ?[]const u8 = null,
};

pub const ResolveOutput = struct {
    nutA: cells.Payload,
    stringA: cells.Payload,
    nutB: cells.Payload,
    stringB: cells.Payload,
    playerA: cells.Payload,
    playerB: cells.Payload,
    winner: physics.Winner,
};

pub const ResolveError = GenesisError || error{
    NotAPair,
    OwnersDiffer,
    MatchDoesNotReferenceCells,
    MatchCertsMismatch,
    MatchSigAInvalid,
    MatchSigBInvalid,
    MatchArbiterSigInvalid,
    TurnsCountMismatch,
    TurnsRootMismatch,
    TurnWrongMatchOrIndex,
    TurnSignedByStranger,
    StrikerIsTarget,
    StrikerSigInvalid,
    TargetSigInvalid,
    WithdrawNeedsBothOrArbiter,
    WithdrawUnknownReason,
    TurnNotASwingOrWithdraw,
    SwingClaimDiffersFromReplay,
    SwingSnapDiffersFromReplay,
    MatchResultDiffersFromReplay,
    PlayerCellBelongsToSomeoneElse,
    CounterOverflow,
};

const Side = physics.Side;

fn sideOf(cert: [32]u8, cert_a: [32]u8, cert_b: [32]u8) error{TurnSignedByStranger}!Side {
    if (eq(cert, cert_a)) return .a;
    if (eq(cert, cert_b)) return .b;
    return error.TurnSignedByStranger;
}
fn ix(s: Side) usize {
    return @intFromEnum(s);
}
fn won(w: physics.Winner, s: Side) bool {
    return (w == .a and s == .a) or (w == .b and s == .b);
}
fn inc(comptime T: type, p: *T, by: T) error{CounterOverflow}!void {
    p.* = std.math.add(T, p.*, by) catch return error.CounterOverflow;
}

pub fn resolveMatch(i: ResolveInput) ResolveError!ResolveOutput {
    const nA = try verifyGenesis(cells.Nut, i.nutA);
    const sA = try verifyGenesis(cells.String, i.stringA);
    const nB = try verifyGenesis(cells.Nut, i.nutB);
    const sB = try verifyGenesis(cells.String, i.stringB);
    if (!eq(nA.pairId, sA.pairId) or !eq(nB.pairId, sB.pairId)) return error.NotAPair;
    if (!eq(nA.owner, sA.owner) or !eq(nB.owner, sB.owner)) return error.OwnersDiffer;
    const owners = [2][33]u8{ nA.owner, nB.owner };
    const certs = [2][32]u8{ certIdOf(nA.owner), certIdOf(nB.owner) };

    const m = try cells.decode(cells.Match, i.match);
    if (!eq(m.nutA, cellRef(i.nutA)) or !eq(m.stringA, cellRef(i.stringA)) or !eq(m.nutB, cellRef(i.nutB)) or !eq(m.stringB, cellRef(i.stringB))) return error.MatchDoesNotReferenceCells;
    if (!eq(m.certA, certs[0]) or !eq(m.certB, certs[1])) return error.MatchCertsMismatch;
    const signed = cells.signedBytes(cells.Match, i.match);
    if (!verifyField(m.sigA, signed, owners[0])) return error.MatchSigAInvalid;
    if (!verifyField(m.sigB, signed, owners[1])) return error.MatchSigBInvalid;
    if (!verifyField(m.arbiterSig, signed, i.arbiterPub)) return error.MatchArbiterSigInvalid;
    if (m.turns != i.turns.len) return error.TurnsCountMismatch;
    if (!eq(m.turnsRoot, turnsRoot(i.turns))) return error.TurnsRootMismatch;
    const match_id = m.matchId;

    // decode and verify each turn; only the first maxTurns are replayed, every one is counted
    var replay: [physics.TUNING.maxTurns]physics.Turn = undefined;
    var nrep: usize = 0;
    var faced = [2]u32{ 0, 0 };
    var withdrew = [2]u32{ 0, 0 };
    var stalled = [2]u32{ 0, 0 };
    for (i.turns, 0..) |t, idx| {
        const kind = cells.kindOf(t) catch return error.TurnNotASwingOrWithdraw;
        switch (kind) {
            .swing => {
                const s = try cells.decode(cells.Swing, t);
                if (!eq(s.matchId, match_id) or s.turn != idx) return error.TurnWrongMatchOrIndex;
                const striker = try sideOf(s.strikerCert, certs[0], certs[1]);
                const target = try sideOf(s.targetCert, certs[0], certs[1]);
                if (striker == target) return error.StrikerIsTarget;
                const sb = cells.signedBytes(cells.Swing, t);
                if (!verifyField(s.strikerSig, sb, owners[ix(striker)])) return error.StrikerSigInvalid;
                if (!verifyField(s.targetSig, sb, owners[ix(target)])) return error.TargetSigInvalid;
                if (nrep < replay.len) {
                    replay[nrep] = .{ .swing = .{ .striker = striker, .swing = .{
                        .imuSpeedCmps = s.imuSpeedCmps, .dopplerSpeedCmps = s.dopplerSpeedCmps, .planeDeg = s.planeDeg,
                        .twistDegps = s.twistDegps, .timingMs = s.timingMs, .followThrough = s.followThrough == 1,
                    } } };
                    nrep += 1;
                }
                try inc(u32, &faced[ix(target)], 1);
            },
            .withdraw => {
                const w = try cells.decode(cells.Withdraw, t);
                if (!eq(w.matchId, match_id) or w.turn != idx) return error.TurnWrongMatchOrIndex;
                const by = try sideOf(w.byCert, certs[0], certs[1]);
                const other: Side = if (by == .a) .b else .a;
                const wb = cells.signedBytes(cells.Withdraw, t);
                const by_ok = verifyField(w.sigBy, wb, owners[ix(by)]);
                const other_ok = verifyField(w.sigOther, wb, owners[ix(other)]);
                const arb_ok = !eq(w.arbiterSig, Z64) and verifyField(w.arbiterSig, wb, i.arbiterPub);
                if (!((by_ok and other_ok) or arb_ok)) return error.WithdrawNeedsBothOrArbiter;
                if (w.reason == 1) {
                    if (nrep < replay.len) {
                        replay[nrep] = .{ .withdraw = by };
                        nrep += 1;
                    }
                    try inc(u32, &withdrew[ix(by)], 1);
                    try inc(u32, &faced[ix(by)], 1);
                } else if (w.reason == 2) {
                    if (nrep < replay.len) {
                        replay[nrep] = .{ .stall = by };
                        nrep += 1;
                    }
                    try inc(u32, &stalled[ix(by)], 1);
                } else return error.WithdrawUnknownReason;
            },
            else => return error.TurnNotASwingOrWithdraw,
        }
    }

    // replay and compare with every claim
    const pre = physics.previewMatch(stateOf(nA, sA), stateOf(nB, sB), replay[0..nrep]);
    for (pre.turns()) |r| {
        const imp = r.impact orelse continue;
        const s = try cells.decode(cells.Swing, i.turns[r.turn]);
        if (s.scoreBp != r.scoreBp.? or s.damageStriker != imp.damageStriker or s.damageTarget != imp.damageTarget) return error.SwingClaimDiffersFromReplay;
        const snapped: u8 = (if (imp.snappedStriker) @as(u8, 1) else 0) | (if (imp.snappedTarget) @as(u8, 2) else 0);
        if (s.snapped != snapped) return error.SwingSnapDiffersFromReplay;
    }
    const winner_byte: u8 = switch (pre.winner) {
        .draw => 0,
        .a => 1,
        .b => 2,
    };
    if (m.hpA != pre.a.hp or m.hpB != pre.b.hp or m.intactA != @intFromBool(pre.a.intact) or m.intactB != @intFromBool(pre.b.intact) or m.winner != winner_byte) return error.MatchResultDiffersFromReplay;

    // successors
    const S = struct {
        fn nut(n: cells.Nut, st: physics.ConkerState, w: bool, l: bool) error{CounterOverflow}!cells.Payload {
            var o = n;
            o.hp = st.hp;
            try inc(u16, &o.wins, @intFromBool(w));
            try inc(u16, &o.losses, @intFromBool(l));
            try inc(u32, &o.generation, 1);
            return cells.encode(o);
        }
        fn string(s: cells.String, st: physics.ConkerState) error{CounterOverflow}!cells.Payload {
            var o = s;
            o.intact = @intFromBool(st.intact);
            try inc(u32, &o.generation, 1);
            return cells.encode(o);
        }
    };
    const player = struct {
        fn make(prev: ?[]const u8, cert: [32]u8, s: Side, p_: *const physics.MatchPreview, f: [2]u32, wd: [2]u32, st: [2]u32, mid: [32]u8) ResolveError!cells.Payload {
            var p: cells.Player = if (prev) |pp| try cells.decode(cells.Player, pp) else .{ .certId = cert, .challenges = 0, .withdrawals = 0, .stalls = 0, .matches = 0, .wins = 0, .lastMatchId = Z32 };
            if (!eq(p.certId, cert)) return error.PlayerCellBelongsToSomeoneElse;
            try inc(u32, &p.challenges, f[ix(s)]);
            try inc(u32, &p.withdrawals, wd[ix(s)]);
            try inc(u32, &p.stalls, st[ix(s)]);
            try inc(u32, &p.matches, 1);
            try inc(u32, &p.wins, @intFromBool(won(p_.winner, s)));
            p.lastMatchId = mid;
            return cells.encode(p);
        }
    };
    return .{
        .nutA = try S.nut(nA, pre.a, pre.winner == .a, pre.winner == .b),
        .stringA = try S.string(sA, pre.a),
        .nutB = try S.nut(nB, pre.b, pre.winner == .b, pre.winner == .a),
        .stringB = try S.string(sB, pre.b),
        .playerA = try player.make(i.playerA, certs[0], .a, &pre, faced, withdrew, stalled, match_id),
        .playerB = try player.make(i.playerB, certs[1], .b, &pre, faced, withdrew, stalled, match_id),
        .winner = pre.winner,
    };
}

// ── transferPair ─────────────────────────────────────────────────────────────

pub const Transfer = struct { nut: cells.Payload, string: cells.Payload, lock: script.Script, mintLocktime: u32 };
pub const TransferError = GenesisError || error{ OwnersDiffer, TransferSignatureInvalid, CounterOverflow };

/// New owner on both cells. `sig` is the current owner's compact signature over
/// sha256(nut || string || newOwner).
pub fn transferPair(nut: []const u8, string: []const u8, new_owner: [33]u8, sig: [64]u8) TransferError!Transfer {
    const n = try verifyGenesis(cells.Nut, nut);
    const s = try verifyGenesis(cells.String, string);
    if (!eq(n.owner, s.owner)) return error.OwnersDiffer;
    var msg: [2 * cells.PAYLOAD_SIZE + 33]u8 = undefined;
    msg[0..cells.PAYLOAD_SIZE].* = nut[0..cells.PAYLOAD_SIZE].*;
    msg[cells.PAYLOAD_SIZE .. 2 * cells.PAYLOAD_SIZE].* = string[0..cells.PAYLOAD_SIZE].*;
    msg[2 * cells.PAYLOAD_SIZE ..].* = new_owner;
    if (!verifyField(sig, &msg, n.owner)) return error.TransferSignatureInvalid;
    var nn = n;
    nn.owner = new_owner;
    try inc(u32, &nn.generation, 1);
    var ss = s;
    ss.owner = new_owner;
    try inc(u32, &ss.generation, 1);
    return .{ .nut = cells.encode(nn), .string = cells.encode(ss), .lock = script.conkerLock(script.hash160(&new_owner), 0), .mintLocktime = 0 };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
// Byte-exact fixtures (noble-signed) live in vectors_test.zig; these use Zig-signed
// keys and cover the shapes and the rejection paths that need no re-signing.

const testing = std.testing;

fn keyFrom(name: []const u8) !Ecdsa.KeyPair {
    const seed = sha256(name);
    return Ecdsa.KeyPair.fromSecretKey(try Ecdsa.SecretKey.fromBytes(seed));
}
fn signField(kp: Ecdsa.KeyPair, bytes: []const u8) ![64]u8 {
    return (try kp.sign(bytes, null)).toBytes();
}

test "mint → verifyGenesis → transfer round trip with Zig-signed keys" {
    const issuer = try keyFrom("issuer");
    const alice = try keyFrom("alice");
    const carol = try keyFrom("carol");
    const genesis_sig = try signField(issuer, GENESIS_MESSAGE);
    const A = try mintPair(.{ .genesisSig = genesis_sig, .issuerPub = issuer.public_key.toCompressedSec1(), .serial = 1, .ownerPub = alice.public_key.toCompressedSec1(), .mintLocktime = 800000 });
    try testing.expectEqual(physics.HP_MAX, (try verifyGenesis(cells.Nut, &A.nut)).hp);
    try testing.expectEqual(@as(u8, 1), (try verifyGenesis(cells.String, &A.string)).intact);
    try testing.expectEqual(@as(usize, 520), A.lock.len);

    // forged props and a foreign issuer are rejected
    var forged = try cells.decode(cells.Nut, &A.nut);
    forged.hardness = 100;
    try testing.expectError(error.PropsForged, verifyGenesis(cells.Nut, &cells.encode(forged)));
    try testing.expectError(error.GenesisSignatureInvalid, mintPair(.{ .genesisSig = genesis_sig, .issuerPub = alice.public_key.toCompressedSec1(), .serial = 1, .ownerPub = alice.public_key.toCompressedSec1(), .mintLocktime = 0 }));

    // transfer to carol with alice's signature; bob's signature is refused
    const new_owner = carol.public_key.toCompressedSec1();
    var msg: [2 * cells.PAYLOAD_SIZE + 33]u8 = undefined;
    msg[0..768].* = A.nut;
    msg[768..1536].* = A.string;
    msg[1536..].* = new_owner;
    const t = try transferPair(&A.nut, &A.string, new_owner, try signField(alice, &msg));
    try testing.expectEqualSlices(u8, &new_owner, &(try cells.decode(cells.Nut, &t.nut)).owner);
    try testing.expectEqual(@as(u32, 1), (try cells.decode(cells.String, &t.string)).generation);
    const bob = try keyFrom("bob");
    try testing.expectError(error.TransferSignatureInvalid, transferPair(&A.nut, &A.string, new_owner, try signField(bob, &msg)));
}

test "turnsRoot chains from a zero root" {
    const none = turnsRoot(&.{});
    try testing.expectEqualSlices(u8, &Z32, &none);
    const one = [_]u8{1} ** 768;
    var buf: [64]u8 = undefined;
    buf[0..32].* = Z32;
    buf[32..].* = cellRef(&one);
    try testing.expectEqualSlices(u8, &sha256(&buf), &turnsRoot(&.{&one}));
}
