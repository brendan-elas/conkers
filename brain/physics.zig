// conkers_physics — swing score, impact and match preview, spec/swing-score.md.
// Port of mirror/src/physics.ts: integer arithmetic only, so this tier
// reproduces the mirror's bytes exactly. Every constant is a starting guess
// that phase 2 step 1 replaces with measured ones; change them in both tiers
// and regenerate spec/vectors.json.
//
// Units: mass cg, speed cm/s, length cm, string strength dN, elasticity
// percent, hp 0..10000, score basis points 0..10000, tension mN.

const std = @import("std");
const derive = @import("conkers_derive");

pub const BP: i64 = 10000;
pub const HP_MAX: u16 = 10000;

pub const TUNING = struct {
    /// |imu - doppler| may be at most this share of the larger, in percent
    pub const speedAgreementPct: i64 = 25;
    pub const speedIdealCmps: i64 = 300;
    pub const speedZeroLowCmps: i64 = 150;
    pub const speedZeroHighCmps: i64 = 500;
    pub const planeZeroDeg: i64 = 25;
    pub const twistZeroDegps: i64 = 90;
    pub const timingZeroMs: i64 = 150;
    /// factor when the striker braked before impact (bp)
    pub const noFollowThroughBp: i64 = 3000;
    /// damage = J_eff^2 / ((hardness + hardnessOffset) * damageDivisor)
    pub const hardnessOffset: u128 = 25;
    pub const damageDivisor: u128 = 475_000;
    /// the target nut, anchored and still, takes this share of the striker's damage, percent
    pub const strikerEdgePct: u128 = 125;
    /// impact tension (mN) = J_eff / snapDivisor
    pub const snapDivisor: u128 = 150;
    /// a match ends after this many turns if nothing broke
    pub const maxTurns: usize = 20;
};

pub const SwingInputs = struct {
    imuSpeedCmps: u16,
    dopplerSpeedCmps: u16,
    planeDeg: u8,
    twistDegps: u16,
    timingMs: i16,
    followThrough: bool,
};

/// Linear fall-off from BP at `ideal` to 0 at `ideal ± zero`. All operands non-negative
/// at the division, so trunc == the mirror's Math.floor.
fn tent(x: i64, ideal: i64, zero_low: i64, zero_high: i64) i64 {
    const d = x - ideal;
    const w = if (d < 0) ideal - zero_low else zero_high - ideal;
    const a: i64 = @intCast(@abs(d));
    if (a >= w) return 0;
    return @divTrunc(BP * (w - a), w);
}

fn mulBp(a: i64, b: i64) i64 {
    return @divTrunc(a * b, BP);
}

/// The speed both phones agree on, or null when they disagree (turn void).
pub fn agreedSpeed(imu: u16, doppler: u16) ?u16 {
    const hi: i64 = @max(imu, doppler);
    if (hi == 0) return null;
    const diff: i64 = @intCast(@abs(@as(i64, imu) - @as(i64, doppler)));
    if (diff * 100 > hi * TUNING.speedAgreementPct) return null;
    return @min(imu, doppler);
}

/// Score in basis points, or null when the two speeds disagree.
pub fn scoreSwing(s: SwingInputs) ?u16 {
    const v = agreedSpeed(s.imuSpeedCmps, s.dopplerSpeedCmps) orelse return null;
    var score = tent(v, TUNING.speedIdealCmps, TUNING.speedZeroLowCmps, TUNING.speedZeroHighCmps);
    score = mulBp(score, tent(s.planeDeg, 0, -TUNING.planeZeroDeg, TUNING.planeZeroDeg));
    score = mulBp(score, tent(s.twistDegps, 0, -TUNING.twistZeroDegps, TUNING.twistZeroDegps));
    score = mulBp(score, tent(@intCast(@abs(@as(i64, s.timingMs))), 0, -TUNING.timingZeroMs, TUNING.timingZeroMs));
    score = mulBp(score, if (s.followThrough) BP else TUNING.noFollowThroughBp);
    return @intCast(score);
}

pub const ConkerState = struct { nut: derive.NutProps, string: derive.StringProps, hp: u16, intact: bool };

pub const ImpactResult = struct {
    /// effective impulse, cg·cm/s, after the score
    impulse: u128,
    damageStriker: u16,
    damageTarget: u16,
    snappedStriker: bool,
    snappedTarget: bool,
};

/// One collision. `v` is the agreed speed, `score_bp` the swing score.
pub fn impact(striker: ConkerState, target: ConkerState, v: u16, score_bp: u16) ImpactResult {
    const m1: u128 = striker.nut.massCg;
    const m2: u128 = target.nut.massCg;
    const e: u128 = (@as(u128, striker.nut.elasticityPct) + target.nut.elasticityPct) / 2;
    const mu = (m1 * m2) / (m1 + m2);
    const j = ((100 + e) * mu * v) / 100;
    const j_eff = (j * score_bp) / @as(u128, @intCast(BP));
    const j2 = j_eff * j_eff;
    const D = struct {
        fn dmg(jj: u128, hardness: u8) u128 {
            return jj / ((@as(u128, hardness) + TUNING.hardnessOffset) * TUNING.damageDivisor);
        }
        fn snaps(je: u128, s: derive.StringProps) bool {
            const tension = ((je / TUNING.snapDivisor) * (100 - @as(u128, s.elasticityPct))) / 100;
            return tension > @as(u128, s.strengthN) * 100;
        }
    };
    const damage_striker = D.dmg(j2, striker.nut.hardness);
    const damage_target = (D.dmg(j2, target.nut.hardness) * TUNING.strikerEdgePct) / 100;
    return .{
        .impulse = j_eff,
        .damageStriker = @intCast(@min(damage_striker, striker.hp)),
        .damageTarget = @intCast(@min(damage_target, target.hp)),
        .snappedStriker = striker.intact and D.snaps(j_eff, striker.string),
        .snappedTarget = target.intact and D.snaps(j_eff, target.string),
    };
}

pub const Side = enum { a, b };

pub const Turn = union(enum) {
    swing: struct { striker: Side, swing: SwingInputs },
    withdraw: Side,
    stall: Side,
};

pub const TurnResult = struct { turn: u16, scoreBp: ?u16, impact: ?ImpactResult, void: bool };

pub const Winner = enum { a, b, draw };
pub const EndedBy = enum { knockout, snap, turns, incomplete };

pub const MatchPreview = struct {
    a: ConkerState,
    b: ConkerState,
    results: [TUNING.maxTurns]TurnResult,
    len: usize,
    winner: Winner,
    endedBy: EndedBy,

    pub fn turns(self: *const MatchPreview) []const TurnResult {
        return self.results[0..self.len];
    }
};

fn out(c: ConkerState) bool {
    return c.hp == 0 or !c.intact;
}

/// Replays turns and returns the state both phones must agree on. Only the first
/// `maxTurns` turns are replayed, as in the mirror.
pub fn previewMatch(a0: ConkerState, b0: ConkerState, turns: []const Turn) MatchPreview {
    var a = a0;
    var b = b0;
    var res: [TUNING.maxTurns]TurnResult = undefined;
    var n: usize = 0;
    var ended: EndedBy = .incomplete;
    var i: usize = 0;
    while (i < turns.len and i < TUNING.maxTurns) : (i += 1) {
        const idx: u16 = @intCast(i);
        switch (turns[i]) {
            .swing => |sw| {
                const score = scoreSwing(sw.swing);
                const v = agreedSpeed(sw.swing.imuSpeedCmps, sw.swing.dopplerSpeedCmps);
                if (score == null or v == null) {
                    res[n] = .{ .turn = idx, .scoreBp = null, .impact = null, .void = true };
                    n += 1;
                    continue;
                }
                const s = if (sw.striker == .a) &a else &b;
                const g = if (sw.striker == .a) &b else &a;
                const r = impact(s.*, g.*, v.?, score.?);
                s.hp -= r.damageStriker;
                g.hp -= r.damageTarget;
                if (r.snappedStriker) s.intact = false;
                if (r.snappedTarget) g.intact = false;
                res[n] = .{ .turn = idx, .scoreBp = score, .impact = r, .void = false };
                n += 1;
                if (out(a) or out(b)) {
                    ended = if (!a.intact or !b.intact) .snap else .knockout;
                    break;
                }
            },
            else => {
                res[n] = .{ .turn = idx, .scoreBp = null, .impact = null, .void = false };
                n += 1;
            },
        }
    }
    if (ended == .incomplete and n >= TUNING.maxTurns) ended = .turns;
    var winner: Winner = .draw;
    if (out(a) != out(b)) {
        winner = if (out(a)) .b else .a;
    } else if (ended == .turns and a.hp != b.hp) {
        winner = if (a.hp > b.hp) .a else .b;
    }
    return .{ .a = a, .b = b, .results = res, .len = n, .winner = winner, .endedBy = ended };
}

// ─── Tests (byte-exact checks against spec/vectors.json live in vectors_test.zig) ───

const testing = std.testing;

const perfect = SwingInputs{ .imuSpeedCmps = 300, .dopplerSpeedCmps = 300, .planeDeg = 0, .twistDegps = 0, .timingMs = 0, .followThrough = true };

test "a perfect swing scores BP; disagreement voids; braking costs 70%" {
    try testing.expectEqual(@as(?u16, 10000), scoreSwing(perfect));
    var s = perfect;
    s.dopplerSpeedCmps = 200;
    try testing.expectEqual(@as(?u16, null), scoreSwing(s));
    s = perfect;
    s.followThrough = false;
    try testing.expectEqual(@as(?u16, 3000), scoreSwing(s));
    try testing.expectEqual(@as(?u16, null), agreedSpeed(0, 0));
}

test "tent is symmetric around the ideal with asymmetric widths" {
    try testing.expectEqual(@as(i64, 10000), tent(300, 300, 150, 500));
    try testing.expectEqual(@as(i64, 5000), tent(225, 300, 150, 500));
    try testing.expectEqual(@as(i64, 5000), tent(400, 300, 150, 500));
    try testing.expectEqual(@as(i64, 0), tent(150, 300, 150, 500));
    try testing.expectEqual(@as(i64, 0), tent(600, 300, 150, 500));
}

test "a match of nothing is a draw, incomplete; 20 withdraws end by turns" {
    const st = ConkerState{ .nut = .{ .massCg = 1000, .volumeCcm3 = 500, .hardness = 50, .elasticityPct = 50 }, .string = .{ .lengthCm = 30, .strengthN = 60, .elasticityPct = 10 }, .hp = HP_MAX, .intact = true };
    const none = previewMatch(st, st, &.{});
    try testing.expectEqual(Winner.draw, none.winner);
    try testing.expectEqual(EndedBy.incomplete, none.endedBy);
    const w = [_]Turn{.{ .withdraw = .a }} ** 20;
    const many = previewMatch(st, st, &w);
    try testing.expectEqual(EndedBy.turns, many.endedBy);
    try testing.expectEqual(@as(usize, 20), many.len);
    try testing.expectEqual(Winner.draw, many.winner);
}

test "damage is clamped at the remaining hp and a knockout ends the match" {
    const soft = ConkerState{ .nut = .{ .massCg = 2000, .volumeCcm3 = 500, .hardness = 1, .elasticityPct = 80 }, .string = .{ .lengthCm = 30, .strengthN = 60, .elasticityPct = 0 }, .hp = 1, .intact = true };
    const hard = ConkerState{ .nut = .{ .massCg = 2000, .volumeCcm3 = 500, .hardness = 100, .elasticityPct = 80 }, .string = .{ .lengthCm = 30, .strengthN = 60, .elasticityPct = 0 }, .hp = HP_MAX, .intact = true };
    const pre = previewMatch(soft, hard, &.{.{ .swing = .{ .striker = .b, .swing = perfect } }});
    try testing.expectEqual(@as(u16, 0), pre.a.hp);
    try testing.expectEqual(Winner.b, pre.winner);
    try testing.expect(pre.endedBy == .knockout or pre.endedBy == .snap);
    try testing.expectEqual(@as(u16, 1), pre.turns()[0].impact.?.damageTarget);
}
