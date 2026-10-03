// conkers_walkers — the brain-side verb.dispatch handlers for the conkers
// cartridge, registered under extension id "conkers". Same shape as
// cartridges/chess/brain/chess_walkers.zig: parse JSON params, call the pure
// verb in conkers_verbs, return a JSON result. Payloads, keys and signatures
// travel as lowercase hex.
//
//   mint            {genesisSig, issuerPub, serial, ownerPub, mintLocktime}
//   verify_genesis  {kind: "nut"|"string", payload}
//   resolve         {nutA, stringA, nutB, stringB, match, turns: [..], arbiterPub, playerA?, playerB?}
//   transfer        {nut, string, newOwner, sig}
//
// Domain refusals (a forged nut, a stranger's signature, a claim the replay
// contradicts) come back as `{ok:false, reason:<ErrorName>}`; only malformed
// params are a DispatchError. The verbs are pure, so State carries nothing but
// a call counter: persistence of the successor cells is the LINEAR cell
// graph's job (P3d late-bound CellStore, later).

const std = @import("std");
const verb_dispatcher = @import("verb_dispatcher");
const verbs = @import("conkers_verbs");
const cells = @import("conkers_cells");

const DispatchError = verb_dispatcher.DispatchError;

pub const State = struct {
    calls: u64 = 0,
};

// ─── JSON in ─────────────────────────────────────────────────────────────────

fn parseObj(allocator: std.mem.Allocator, params_json: []const u8) DispatchError!std.json.Parsed(std.json.Value) {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, params_json, .{}) catch return DispatchError.invalid_params;
    if (parsed.value != .object) {
        parsed.deinit();
        return DispatchError.invalid_params;
    }
    return parsed;
}

fn reqStr(obj: std.json.ObjectMap, key: []const u8) DispatchError![]const u8 {
    const v = obj.get(key) orelse return DispatchError.invalid_params;
    if (v != .string) return DispatchError.invalid_params;
    return v.string;
}

fn reqU32(obj: std.json.ObjectMap, key: []const u8) DispatchError!u32 {
    const v = obj.get(key) orelse return DispatchError.invalid_params;
    if (v != .integer or v.integer < 0 or v.integer > std.math.maxInt(u32)) return DispatchError.invalid_params;
    return @intCast(v.integer);
}

/// A hex string of exactly `n` bytes into a fixed array.
fn reqHex(comptime n: usize, obj: std.json.ObjectMap, key: []const u8) DispatchError![n]u8 {
    const s = try reqStr(obj, key);
    if (s.len != 2 * n) return DispatchError.invalid_params;
    var out: [n]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch return DispatchError.invalid_params;
    return out;
}

fn optHex(comptime n: usize, obj: std.json.ObjectMap, key: []const u8) DispatchError!?[n]u8 {
    const v = obj.get(key) orelse return null;
    if (v == .null) return null;
    return try reqHex(n, obj, key);
}

// ─── JSON out ────────────────────────────────────────────────────────────────

const Out = struct {
    a: std.mem.Allocator,
    b: std.ArrayList(u8) = .empty,

    fn raw(o: *Out, s: []const u8) DispatchError!void {
        o.b.appendSlice(o.a, s) catch return DispatchError.out_of_memory;
    }
    fn hex(o: *Out, bytes: []const u8) DispatchError!void {
        const digits = "0123456789abcdef";
        for (bytes) |c| {
            o.b.append(o.a, digits[c >> 4]) catch return DispatchError.out_of_memory;
            o.b.append(o.a, digits[c & 0x0f]) catch return DispatchError.out_of_memory;
        }
    }
    /// `,"key":"<hex>"`
    fn hexField(o: *Out, key: []const u8, bytes: []const u8) DispatchError!void {
        try o.raw(",\"");
        try o.raw(key);
        try o.raw("\":\"");
        try o.hex(bytes);
        try o.raw("\"");
    }
    /// a bare number
    fn num(o: *Out, v: anytype) DispatchError!void {
        const s = std.fmt.allocPrint(o.a, "{d}", .{v}) catch return DispatchError.out_of_memory;
        defer o.a.free(s);
        try o.raw(s);
    }
    /// `,"key":<int>`
    fn intField(o: *Out, key: []const u8, v: anytype) DispatchError!void {
        const s = std.fmt.allocPrint(o.a, ",\"{s}\":{d}", .{ key, v }) catch return DispatchError.out_of_memory;
        defer o.a.free(s);
        try o.raw(s);
    }
    fn finish(o: *Out) DispatchError![]u8 {
        try o.raw("}");
        return o.b.toOwnedSlice(o.a) catch DispatchError.out_of_memory;
    }
};

fn rejection(allocator: std.mem.Allocator, err: anyerror) DispatchError![]u8 {
    return std.fmt.allocPrint(allocator, "{{\"ok\":false,\"reason\":\"{s}\"}}", .{@errorName(err)}) catch DispatchError.out_of_memory;
}

// ─── Walkers ─────────────────────────────────────────────────────────────────

pub fn mintWalker(allocator: std.mem.Allocator, ctx: *anyopaque, params_json: []const u8) DispatchError![]u8 {
    const state: *State = @ptrCast(@alignCast(ctx));
    state.calls += 1;
    var parsed = try parseObj(allocator, params_json);
    defer parsed.deinit();
    const obj = parsed.value.object;
    const p = verbs.MintParams{
        .genesisSig = try reqHex(64, obj, "genesisSig"),
        .issuerPub = try reqHex(33, obj, "issuerPub"),
        .serial = try reqU32(obj, "serial"),
        .ownerPub = try reqHex(33, obj, "ownerPub"),
        .mintLocktime = try reqU32(obj, "mintLocktime"),
    };
    const m = verbs.mintPair(p) catch |e| return rejection(allocator, e);
    var o = Out{ .a = allocator };
    errdefer o.b.deinit(allocator);
    try o.raw("{\"ok\":true");
    try o.intField("serial", m.conker.serial);
    try o.hexField("pairId", &m.conker.pairId);
    try o.hexField("nut", &m.nut);
    try o.hexField("string", &m.string);
    try o.hexField("lock", m.lock.slice());
    try o.raw(",\"props\":{\"nut\":{\"massCg\":");
    try o.num(m.conker.nut.massCg);
    try o.intField("volumeCcm3", m.conker.nut.volumeCcm3);
    try o.intField("hardness", m.conker.nut.hardness);
    try o.intField("elasticityPct", m.conker.nut.elasticityPct);
    try o.raw("},\"string\":{\"lengthCm\":");
    try o.num(m.conker.string.lengthCm);
    try o.intField("strengthN", m.conker.string.strengthN);
    try o.intField("elasticityPct", m.conker.string.elasticityPct);
    try o.raw("}}");
    return o.finish();
}

pub fn verifyGenesisWalker(allocator: std.mem.Allocator, ctx: *anyopaque, params_json: []const u8) DispatchError![]u8 {
    const state: *State = @ptrCast(@alignCast(ctx));
    state.calls += 1;
    var parsed = try parseObj(allocator, params_json);
    defer parsed.deinit();
    const obj = parsed.value.object;
    const kind = try reqStr(obj, "kind");
    const payload = try reqHex(cells.PAYLOAD_SIZE, obj, "payload");
    var o = Out{ .a = allocator };
    errdefer o.b.deinit(allocator);
    try o.raw("{\"ok\":true,\"kind\":\"");
    try o.raw(kind);
    try o.raw("\"");
    if (std.mem.eql(u8, kind, "nut")) {
        const n = verbs.verifyGenesis(cells.Nut, &payload) catch |e| {
            o.b.deinit(allocator);
            return rejection(allocator, e);
        };
        try o.intField("serial", n.serial);
        try o.hexField("pairId", &n.pairId);
        try o.hexField("owner", &n.owner);
        try o.intField("generation", n.generation);
        try o.intField("massCg", n.massCg);
        try o.intField("volumeCcm3", n.volumeCcm3);
        try o.intField("hardness", n.hardness);
        try o.intField("elasticityPct", n.elasticityPct);
        try o.intField("hp", n.hp);
        try o.intField("wins", n.wins);
        try o.intField("losses", n.losses);
    } else if (std.mem.eql(u8, kind, "string")) {
        const s = verbs.verifyGenesis(cells.String, &payload) catch |e| {
            o.b.deinit(allocator);
            return rejection(allocator, e);
        };
        try o.intField("serial", s.serial);
        try o.hexField("pairId", &s.pairId);
        try o.hexField("owner", &s.owner);
        try o.intField("generation", s.generation);
        try o.intField("lengthCm", s.lengthCm);
        try o.intField("strengthN", s.strengthN);
        try o.intField("elasticityPct", s.elasticityPct);
        try o.intField("intact", s.intact);
    } else {
        o.b.deinit(allocator);
        return DispatchError.invalid_params;
    }
    return o.finish();
}

pub fn resolveWalker(allocator: std.mem.Allocator, ctx: *anyopaque, params_json: []const u8) DispatchError![]u8 {
    const state: *State = @ptrCast(@alignCast(ctx));
    state.calls += 1;
    var parsed = try parseObj(allocator, params_json);
    defer parsed.deinit();
    const obj = parsed.value.object;

    const nutA = try reqHex(cells.PAYLOAD_SIZE, obj, "nutA");
    const stringA = try reqHex(cells.PAYLOAD_SIZE, obj, "stringA");
    const nutB = try reqHex(cells.PAYLOAD_SIZE, obj, "nutB");
    const stringB = try reqHex(cells.PAYLOAD_SIZE, obj, "stringB");
    const match = try reqHex(cells.PAYLOAD_SIZE, obj, "match");
    const arbiter = try reqHex(33, obj, "arbiterPub");
    const playerA = try optHex(cells.PAYLOAD_SIZE, obj, "playerA");
    const playerB = try optHex(cells.PAYLOAD_SIZE, obj, "playerB");

    const turns_v = obj.get("turns") orelse return DispatchError.invalid_params;
    if (turns_v != .array) return DispatchError.invalid_params;
    const turn_bufs = allocator.alloc(cells.Payload, turns_v.array.items.len) catch return DispatchError.out_of_memory;
    defer allocator.free(turn_bufs);
    const turns = allocator.alloc([]const u8, turns_v.array.items.len) catch return DispatchError.out_of_memory;
    defer allocator.free(turns);
    for (turns_v.array.items, 0..) |tv, k| {
        if (tv != .string or tv.string.len != 2 * cells.PAYLOAD_SIZE) return DispatchError.invalid_params;
        _ = std.fmt.hexToBytes(&turn_bufs[k], tv.string) catch return DispatchError.invalid_params;
        turns[k] = &turn_bufs[k];
    }

    const out = verbs.resolveMatch(.{
        .nutA = &nutA, .stringA = &stringA, .nutB = &nutB, .stringB = &stringB,
        .match = &match, .turns = turns, .arbiterPub = arbiter,
        .playerA = if (playerA) |*p| p else null,
        .playerB = if (playerB) |*p| p else null,
    }) catch |e| return rejection(allocator, e);

    var o = Out{ .a = allocator };
    errdefer o.b.deinit(allocator);
    try o.raw("{\"ok\":true,\"winner\":\"");
    try o.raw(@tagName(out.winner));
    try o.raw("\"");
    try o.hexField("nutA", &out.nutA);
    try o.hexField("stringA", &out.stringA);
    try o.hexField("nutB", &out.nutB);
    try o.hexField("stringB", &out.stringB);
    try o.hexField("playerA", &out.playerA);
    try o.hexField("playerB", &out.playerB);
    return o.finish();
}

pub fn transferWalker(allocator: std.mem.Allocator, ctx: *anyopaque, params_json: []const u8) DispatchError![]u8 {
    const state: *State = @ptrCast(@alignCast(ctx));
    state.calls += 1;
    var parsed = try parseObj(allocator, params_json);
    defer parsed.deinit();
    const obj = parsed.value.object;
    const nut = try reqHex(cells.PAYLOAD_SIZE, obj, "nut");
    const string = try reqHex(cells.PAYLOAD_SIZE, obj, "string");
    const new_owner = try reqHex(33, obj, "newOwner");
    const sig = try reqHex(64, obj, "sig");
    const t = verbs.transferPair(&nut, &string, new_owner, sig) catch |e| return rejection(allocator, e);
    var o = Out{ .a = allocator };
    errdefer o.b.deinit(allocator);
    try o.raw("{\"ok\":true");
    try o.hexField("nut", &t.nut);
    try o.hexField("string", &t.string);
    try o.hexField("lock", t.lock.slice());
    try o.intField("mintLocktime", t.mintLocktime);
    return o.finish();
}

// ─── Registration ────────────────────────────────────────────────────────────

pub const EXTENSION_ID = "conkers";

pub fn registerAll(registry: *verb_dispatcher.Registry, state: *State) !void {
    const V = struct { name: []const u8, f: verb_dispatcher.WalkerFn };
    const list = [_]V{
        .{ .name = "mint", .f = mintWalker },
        .{ .name = "verify_genesis", .f = verifyGenesisWalker },
        .{ .name = "resolve", .f = resolveWalker },
        .{ .name = "transfer", .f = transferWalker },
    };
    for (list) |v| {
        try registry.register(.{ .extension_id = EXTENSION_ID, .verb = v.name, .walker_fn = v.f, .ctx = @ptrCast(state) });
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────
// Dispatch the DEV vectors through the real registry and compare the hex the
// mirror produced. spec/vectors.json is the `conkers_vectors` data module.

const testing = std.testing;
const vectors_json = @embedFile("conkers_vectors");

fn contains(h: []const u8, n: []const u8) bool {
    return std.mem.indexOf(u8, h, n) != null;
}

const Harness = struct {
    state: State = .{},
    reg: verb_dispatcher.Registry = undefined,
    vec: std.json.Parsed(std.json.Value) = undefined,

    /// In place: the registry keeps a pointer to `state`, so the harness must not move after this.
    fn setup(h: *Harness) !void {
        h.reg = verb_dispatcher.Registry.init(testing.allocator);
        h.vec = try std.json.parseFromSlice(std.json.Value, testing.allocator, vectors_json, .{});
        try registerAll(&h.reg, &h.state);
    }
    fn deinit(h: *Harness) void {
        h.reg.deinit();
        h.vec.deinit();
    }
    fn obj(h: *const Harness) std.json.ObjectMap {
        return h.vec.value.object;
    }
    fn call(h: *const Harness, verb: []const u8, params: []const u8) ![]u8 {
        return h.reg.dispatch(testing.allocator, EXTENSION_ID, verb, params);
    }
};

test "registerAll registers the four conkers verbs" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    try testing.expectEqual(@as(usize, 4), h.reg.count());
    try testing.expect(h.reg.hasExtension("conkers"));
}

test "mint reproduces the mirror's nut, string and lock bytes" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    const v = h.obj();
    const m0 = v.get("mints").?.array.items[0].object;
    const params = try std.fmt.allocPrint(testing.allocator, "{{\"genesisSig\":\"{s}\",\"issuerPub\":\"{s}\",\"serial\":{d},\"ownerPub\":\"{s}\",\"mintLocktime\":{d}}}", .{
        v.get("genesisSig").?.string, v.get("issuerPubKey").?.string, m0.get("serial").?.integer, m0.get("ownerPub").?.string, m0.get("mintLocktime").?.integer,
    });
    defer testing.allocator.free(params);
    const r = try h.call("mint", params);
    defer testing.allocator.free(r);
    try testing.expect(contains(r, "\"ok\":true"));
    try testing.expect(contains(r, m0.get("nut").?.string));
    try testing.expect(contains(r, m0.get("string").?.string));
    try testing.expect(contains(r, m0.get("lock").?.string));
    try testing.expect(contains(r, "\"props\":{\"nut\":{\"massCg\":"));
    try testing.expectEqual(@as(u64, 1), h.state.calls);
}

test "verify_genesis accepts a minted nut and refuses a forged one with a reason body" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    const m0 = h.obj().get("mints").?.array.items[0].object;
    const nut_hex = m0.get("nut").?.string;
    const ok_params = try std.fmt.allocPrint(testing.allocator, "{{\"kind\":\"nut\",\"payload\":\"{s}\"}}", .{nut_hex});
    defer testing.allocator.free(ok_params);
    const ok = try h.call("verify_genesis", ok_params);
    defer testing.allocator.free(ok);
    try testing.expect(contains(ok, "\"ok\":true,\"kind\":\"nut\",\"serial\":1,"));
    try testing.expect(contains(ok, "\"hp\":10000"));

    // flip the hardness byte (offset 48)
    const forged = try testing.allocator.dupe(u8, nut_hex);
    defer testing.allocator.free(forged);
    forged[96] = if (forged[96] == 'f') 'e' else 'f';
    const bad_params = try std.fmt.allocPrint(testing.allocator, "{{\"kind\":\"nut\",\"payload\":\"{s}\"}}", .{forged});
    defer testing.allocator.free(bad_params);
    const bad = try h.call("verify_genesis", bad_params);
    defer testing.allocator.free(bad);
    try testing.expect(contains(bad, "{\"ok\":false,\"reason\":\"PropsForged\"}"));
}

test "resolve reproduces the mirror's successors; a dropped turn is refused" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    const rv = h.obj().get("resolve").?.object;
    var turns: std.ArrayList(u8) = .empty;
    defer turns.deinit(testing.allocator);
    for (rv.get("turns").?.array.items, 0..) |t, k| {
        if (k > 0) try turns.append(testing.allocator, ',');
        try turns.append(testing.allocator, '"');
        try turns.appendSlice(testing.allocator, t.string);
        try turns.append(testing.allocator, '"');
    }
    const fmt = "{{\"nutA\":\"{s}\",\"stringA\":\"{s}\",\"nutB\":\"{s}\",\"stringB\":\"{s}\",\"match\":\"{s}\",\"turns\":[{s}],\"arbiterPub\":\"{s}\",\"playerA\":null,\"playerB\":\"{s}\"}}";
    const params = try std.fmt.allocPrint(testing.allocator, fmt, .{
        rv.get("nutA").?.string, rv.get("stringA").?.string, rv.get("nutB").?.string, rv.get("stringB").?.string,
        rv.get("match").?.string, turns.items, rv.get("arbiterPub").?.string, rv.get("playerB").?.string,
    });
    defer testing.allocator.free(params);
    const r = try h.call("resolve", params);
    defer testing.allocator.free(r);
    const out = rv.get("out").?.object;
    try testing.expect(contains(r, "\"ok\":true,\"winner\":\""));
    try testing.expect(contains(r, out.get("winner").?.string));
    inline for (.{ "nutA", "stringA", "nutB", "stringB", "playerA", "playerB" }) |k| try testing.expect(contains(r, out.get(k).?.string));

    // drop the last turn: the match's count no longer agrees
    const last_comma = std.mem.lastIndexOfScalar(u8, turns.items, ',').?;
    const fewer = try std.fmt.allocPrint(testing.allocator, fmt, .{
        rv.get("nutA").?.string, rv.get("stringA").?.string, rv.get("nutB").?.string, rv.get("stringB").?.string,
        rv.get("match").?.string, turns.items[0..last_comma], rv.get("arbiterPub").?.string, rv.get("playerB").?.string,
    });
    defer testing.allocator.free(fewer);
    const bad = try h.call("resolve", fewer);
    defer testing.allocator.free(bad);
    try testing.expectEqualStrings("{\"ok\":false,\"reason\":\"TurnsCountMismatch\"}", bad);
}

test "transfer reproduces the mirror's successors and lock" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    const tv = h.obj().get("transfer").?.object;
    const params = try std.fmt.allocPrint(testing.allocator, "{{\"nut\":\"{s}\",\"string\":\"{s}\",\"newOwner\":\"{s}\",\"sig\":\"{s}\"}}", .{
        tv.get("nut").?.string, tv.get("string").?.string, tv.get("newOwner").?.string, tv.get("sig").?.string,
    });
    defer testing.allocator.free(params);
    const r = try h.call("transfer", params);
    defer testing.allocator.free(r);
    const out = tv.get("out").?.object;
    try testing.expect(contains(r, out.get("nut").?.string));
    try testing.expect(contains(r, out.get("string").?.string));
    try testing.expect(contains(r, out.get("lock").?.string));
    try testing.expect(contains(r, "\"mintLocktime\":0}"));
}

test "malformed params → invalid_params; unknown verb → walker_not_found" {
    var h = Harness{};
    try h.setup();
    defer h.deinit();
    try testing.expectError(DispatchError.invalid_params, h.call("mint", "{\"serial\":1}"));
    try testing.expectError(DispatchError.invalid_params, h.call("verify_genesis", "{\"kind\":\"nut\",\"payload\":\"zz\"}"));
    try testing.expectError(DispatchError.invalid_params, h.call("resolve", "[]"));
    try testing.expectError(DispatchError.walker_not_found, h.call("swing", "{}"));
}
