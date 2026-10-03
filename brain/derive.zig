// conkers_derive — genesis derivation, spec/genesis.md. Port of mirror/src/derive.ts.
//
//   h0 = sha256(S || serial_be32); hn = sha256(h(n-1)) for n = 1..7
//
// One property per hash, integers only, so this tier produces the same bytes
// as the TypeScript mirror. Field names are the spec's names in every tier.

const std = @import("std");
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const NutProps = struct {
    /// centigrams 500..2000
    massCg: u16,
    /// centi-cm³ 200..1200
    volumeCcm3: u16,
    /// 1..100
    hardness: u8,
    /// percent 20..80
    elasticityPct: u8,
};

pub const StringProps = struct {
    /// cm 20..40
    lengthCm: u8,
    /// deci-newtons 10..60
    strengthN: u8,
    /// percent 0..30
    elasticityPct: u8,
};

pub const Conker = struct {
    serial: u32,
    /// h0: links nut and string, seeds cosmetics
    pairId: [32]u8,
    nut: NutProps,
    string: StringProps,
};

pub const CHAIN_LENGTH = 8;

pub fn hashChain(genesis_sig: [64]u8, serial: u32) [CHAIN_LENGTH][32]u8 {
    var seed: [68]u8 = undefined;
    seed[0..64].* = genesis_sig;
    std.mem.writeInt(u32, seed[64..68], serial, .big);
    var chain: [CHAIN_LENGTH][32]u8 = undefined;
    Sha256.hash(&seed, &chain[0], .{});
    var n: usize = 1;
    while (n < CHAIN_LENGTH) : (n += 1) Sha256.hash(&chain[n - 1], &chain[n], .{});
    return chain;
}

fn u32be(h: [32]u8) u32 {
    return std.mem.readInt(u32, h[0..4], .big);
}

pub fn deriveConker(genesis_sig: [64]u8, serial: u32) Conker {
    const h = hashChain(genesis_sig, serial);
    return .{
        .serial = serial,
        .pairId = h[0],
        .nut = .{
            .massCg = @intCast(500 + (u32be(h[1]) % 1501)),
            .volumeCcm3 = @intCast(200 + (u32be(h[2]) % 1001)),
            .hardness = @intCast(1 + (u32be(h[3]) % 100)),
            .elasticityPct = @intCast(20 + (u32be(h[4]) % 61)),
        },
        .string = .{
            .lengthCm = @intCast(20 + (u32be(h[5]) % 21)),
            .strengthN = @intCast(10 + (u32be(h[6]) % 51)),
            .elasticityPct = @intCast(u32be(h[7]) % 31),
        },
    };
}

// ─── Tests (the byte-exact check against spec/vectors.json is in vectors_test.zig) ───

const testing = std.testing;

test "chain is 8 hashes, h0 depends on the serial, hn = sha256(h(n-1))" {
    const sig = [_]u8{0x11} ** 64;
    const c0 = hashChain(sig, 0);
    const c1 = hashChain(sig, 1);
    try testing.expect(!std.mem.eql(u8, &c0[0], &c1[0]));
    var want: [32]u8 = undefined;
    Sha256.hash(&c0[0], &want, .{});
    try testing.expectEqualSlices(u8, &want, &c0[1]);
}

test "every property lands in its spec range" {
    const sig = [_]u8{0x42} ** 64;
    var serial: u32 = 0;
    while (serial < 200) : (serial += 1) {
        const c = deriveConker(sig, serial);
        try testing.expect(c.nut.massCg >= 500 and c.nut.massCg <= 2000);
        try testing.expect(c.nut.volumeCcm3 >= 200 and c.nut.volumeCcm3 <= 1200);
        try testing.expect(c.nut.hardness >= 1 and c.nut.hardness <= 100);
        try testing.expect(c.nut.elasticityPct >= 20 and c.nut.elasticityPct <= 80);
        try testing.expect(c.string.lengthCm >= 20 and c.string.lengthCm <= 40);
        try testing.expect(c.string.strengthN >= 10 and c.string.strengthN <= 60);
        try testing.expect(c.string.elasticityPct <= 30);
    }
}
