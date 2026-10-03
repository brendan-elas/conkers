// Every entry of spec/vectors.json, re-derived, re-computed and re-encoded by
// the Zig tier and compared byte for byte with what the TypeScript mirror
// wrote. This is the contract between the tiers: if it fails, one of them
// changed and the other must follow (then `pnpm --filter @conkers/mirror vectors`).

const std = @import("std");
const derive = @import("conkers_derive");
const cells = @import("conkers_cells");
const physics = @import("conkers_physics");
const script = @import("conkers_script");
const verbs = @import("conkers_verbs");

const testing = std.testing;
const raw = @embedFile("conkers_vectors");

const Vec = struct {
    parsed: std.json.Parsed(std.json.Value),
    fn load() !Vec {
        return .{ .parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, raw, .{}) };
    }
    fn deinit(v: *Vec) void {
        v.parsed.deinit();
    }
    fn root(v: *const Vec) std.json.ObjectMap {
        return v.parsed.value.object;
    }
};

fn unhex(comptime n: usize, s: []const u8) ![n]u8 {
    if (s.len != 2 * n) return error.WrongHexLength;
    var out: [n]u8 = undefined;
    _ = try std.fmt.hexToBytes(&out, s);
    return out;
}

fn unhexAlloc(s: []const u8) ![]u8 {
    const out = try testing.allocator.alloc(u8, s.len / 2);
    errdefer testing.allocator.free(out);
    _ = try std.fmt.hexToBytes(out, s);
    return out;
}

/// expect bytes == the hex string
fn expectHex(expected_hex: []const u8, bytes: []const u8) !void {
    const want = try unhexAlloc(expected_hex);
    defer testing.allocator.free(want);
    try testing.expectEqualSlices(u8, want, bytes);
}

fn int(o: std.json.ObjectMap, k: []const u8) i64 {
    return o.get(k).?.integer;
}
fn str(o: std.json.ObjectMap, k: []const u8) []const u8 {
    return o.get(k).?.string;
}

test "genesis signature verifies under the issuer key" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    try testing.expectEqualStrings(verbs.GENESIS_MESSAGE, str(r, "genesisMessage"));
    try testing.expect(verbs.verifyField(try unhex(64, str(r, "genesisSig")), str(r, "genesisMessage"), try unhex(33, str(r, "issuerPubKey"))));
}

test "every conker re-derives" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    const sig = try unhex(64, str(r, "genesisSig"));
    for (r.get("conkers").?.array.items) |cv| {
        const c = cv.object;
        const got = derive.deriveConker(sig, @intCast(int(c, "serial")));
        try expectHex(str(c, "pairId"), &got.pairId);
        const n = c.get("nut").?.object;
        try testing.expectEqual(derive.NutProps{ .massCg = @intCast(int(n, "massCg")), .volumeCcm3 = @intCast(int(n, "volumeCcm3")), .hardness = @intCast(int(n, "hardness")), .elasticityPct = @intCast(int(n, "elasticityPct")) }, got.nut);
        const s = c.get("string").?.object;
        try testing.expectEqual(derive.StringProps{ .lengthCm = @intCast(int(s, "lengthCm")), .strengthN = @intCast(int(s, "strengthN")), .elasticityPct = @intCast(int(s, "elasticityPct")) }, got.string);
    }
}

fn conkerBySerial(r: std.json.ObjectMap, serial: i64) !derive.Conker {
    const sig = try unhex(64, str(r, "genesisSig"));
    return derive.deriveConker(sig, @intCast(serial));
}

test "every impact re-computes" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    for (r.get("impacts").?.array.items) |iv| {
        const i = iv.object;
        const sw = i.get("swing").?.object;
        const swing = physics.SwingInputs{
            .imuSpeedCmps = @intCast(int(sw, "imuSpeedCmps")), .dopplerSpeedCmps = @intCast(int(sw, "dopplerSpeedCmps")),
            .planeDeg = @intCast(int(sw, "planeDeg")), .twistDegps = @intCast(int(sw, "twistDegps")),
            .timingMs = @intCast(int(sw, "timingMs")), .followThrough = sw.get("followThrough").?.bool,
        };
        const score_bp: u16 = @intCast(int(i, "scoreBp"));
        try testing.expectEqual(@as(?u16, score_bp), physics.scoreSwing(swing));
        const cs = try conkerBySerial(r, int(i, "striker"));
        const ct = try conkerBySerial(r, int(i, "target"));
        const st = physics.ConkerState{ .nut = cs.nut, .string = cs.string, .hp = physics.HP_MAX, .intact = true };
        const tg = physics.ConkerState{ .nut = ct.nut, .string = ct.string, .hp = physics.HP_MAX, .intact = true };
        const res = physics.impact(st, tg, @min(swing.imuSpeedCmps, swing.dopplerSpeedCmps), score_bp);
        const impulse = try std.fmt.allocPrint(testing.allocator, "{d}", .{res.impulse});
        defer testing.allocator.free(impulse);
        try testing.expectEqualStrings(str(i, "impulse"), impulse);
        try testing.expectEqual(@as(u16, @intCast(int(i, "damageStriker"))), res.damageStriker);
        try testing.expectEqual(@as(u16, @intCast(int(i, "damageTarget"))), res.damageTarget);
        try testing.expectEqual(i.get("snappedStriker").?.bool, res.snappedStriker);
        try testing.expectEqual(i.get("snappedTarget").?.bool, res.snappedTarget);
    }
}

test "the push-tx block and every lock are the mirror's bytes" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    try expectHex(str(r, "pushTx"), &script.PUSHTX);
    for (r.get("locks").?.array.items) |lv| {
        const l = lv.object;
        const lock = script.conkerLock(try unhex(20, str(l, "ownerPkh")), @intCast(int(l, "mintLocktime")));
        try expectHex(str(l, "lock"), lock.slice());
    }
}

test "every mint re-encodes to the same nut, string and lock" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    for (r.get("mints").?.array.items) |mv| {
        const m = mv.object;
        const got = try verbs.mintPair(.{
            .genesisSig = try unhex(64, str(r, "genesisSig")), .issuerPub = try unhex(33, str(r, "issuerPubKey")),
            .serial = @intCast(int(m, "serial")), .ownerPub = try unhex(33, str(m, "ownerPub")), .mintLocktime = @intCast(int(m, "mintLocktime")),
        });
        try expectHex(str(m, "nut"), &got.nut);
        try expectHex(str(m, "string"), &got.string);
        try expectHex(str(m, "lock"), got.lock.slice());
        _ = try verbs.verifyGenesis(cells.Nut, &got.nut);
        _ = try verbs.verifyGenesis(cells.String, &got.string);
    }
}

const Fixture = struct {
    nutA: [768]u8,
    stringA: [768]u8,
    nutB: [768]u8,
    stringB: [768]u8,
    match: [768]u8,
    playerB: [768]u8,
    arbiter: [33]u8,
    turn_bufs: [8][768]u8,
    turns: [8][]const u8,
    n: usize,

    fn load(r: std.json.ObjectMap) !Fixture {
        const rv = r.get("resolve").?.object;
        var f: Fixture = undefined;
        f.nutA = try unhex(768, str(rv, "nutA"));
        f.stringA = try unhex(768, str(rv, "stringA"));
        f.nutB = try unhex(768, str(rv, "nutB"));
        f.stringB = try unhex(768, str(rv, "stringB"));
        f.match = try unhex(768, str(rv, "match"));
        f.playerB = try unhex(768, str(rv, "playerB"));
        f.arbiter = try unhex(33, str(rv, "arbiterPub"));
        const items = rv.get("turns").?.array.items;
        f.n = items.len;
        for (items, 0..) |t, k| f.turn_bufs[k] = try unhex(768, t.string);
        return f;
    }
    fn input(f: *Fixture) verbs.ResolveInput {
        for (0..f.n) |k| f.turns[k] = &f.turn_bufs[k];
        return .{ .nutA = &f.nutA, .stringA = &f.stringA, .nutB = &f.nutB, .stringB = &f.stringB, .match = &f.match, .turns = f.turns[0..f.n], .arbiterPub = f.arbiter, .playerB = &f.playerB };
    }
};

test "resolve re-encodes the mirror's successors and player records" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    var f = try Fixture.load(r);
    const out = try verbs.resolveMatch(f.input());
    const want = r.get("resolve").?.object.get("out").?.object;
    try expectHex(str(want, "nutA"), &out.nutA);
    try expectHex(str(want, "stringA"), &out.stringA);
    try expectHex(str(want, "nutB"), &out.nutB);
    try expectHex(str(want, "stringB"), &out.stringB);
    try expectHex(str(want, "playerA"), &out.playerA);
    try expectHex(str(want, "playerB"), &out.playerB);
    try testing.expectEqualStrings(str(want, "winner"), @tagName(out.winner));

    // the player record B carried forward: 10 faced + the two turns it faced here
    const pB = try cells.decode(cells.Player, &out.playerB);
    try testing.expectEqual(@as(u32, 12), pB.challenges);
    try testing.expectEqual(@as(u32, 5), pB.withdrawals);
    try testing.expectEqual(@as(u32, 6), pB.matches);
    const pA = try cells.decode(cells.Player, &out.playerA);
    try testing.expectEqual(@as(u32, 1), pA.challenges);
    try testing.expectEqual(@as(u32, 1), pA.stalls);
    try testing.expectEqual(@as(u32, 1), pA.matches);
}

test "resolve rejects a stranger arbiter, a reordered turn list, a lonely withdraw and a tampered claim" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    var f = try Fixture.load(r);

    var i = f.input();
    i.arbiterPub = (try cells.decode(cells.Nut, &f.nutA)).owner;
    try testing.expectError(error.MatchArbiterSigInvalid, verbs.resolveMatch(i));

    i = f.input();
    i.turns = f.turns[0 .. f.n - 1];
    try testing.expectError(error.TurnsCountMismatch, verbs.resolveMatch(i));

    // swap turns 0 and 1: the root no longer matches before the index check can
    var swapped = f;
    swapped.turn_bufs[0] = f.turn_bufs[1];
    swapped.turn_bufs[1] = f.turn_bufs[0];
    try testing.expectError(error.TurnsRootMismatch, verbs.resolveMatch(swapped.input()));

    // zero the other party's signature on the withdraw (turn 2): both parties or the arbiter
    var lonely = f;
    var w = try cells.decode(cells.Withdraw, &lonely.turn_bufs[2]);
    w.sigOther = [_]u8{0} ** 64;
    lonely.turn_bufs[2] = cells.encode(w);
    // the turns root covers the tampered cell, so that is what trips first
    try testing.expectError(error.TurnsRootMismatch, verbs.resolveMatch(lonely.input()));

    // a claim the replay contradicts, with the root recomputed over the tampered turn,
    // still fails: the striker's signature no longer covers the bytes
    var claim = f;
    var s = try cells.decode(cells.Swing, &claim.turn_bufs[0]);
    s.damageTarget +%= 1;
    claim.turn_bufs[0] = cells.encode(s);
    var m = try cells.decode(cells.Match, &claim.match);
    m.turnsRoot = verbs.turnsRoot(claim.input().turns);
    claim.match = cells.encode(m);
    try testing.expectError(error.MatchSigAInvalid, verbs.resolveMatch(claim.input()));
}

test "transfer re-encodes the mirror's successors and lock" {
    var v = try Vec.load();
    defer v.deinit();
    const r = v.root();
    const tv = r.get("transfer").?.object;
    const nut = try unhex(768, str(tv, "nut"));
    const string = try unhex(768, str(tv, "string"));
    const t = try verbs.transferPair(&nut, &string, try unhex(33, str(tv, "newOwner")), try unhex(64, str(tv, "sig")));
    const want = tv.get("out").?.object;
    try expectHex(str(want, "nut"), &t.nut);
    try expectHex(str(want, "string"), &t.string);
    try expectHex(str(want, "lock"), t.lock.slice());
    try testing.expectEqual(@as(u32, @intCast(int(want, "mintLocktime"))), t.mintLocktime);
}
