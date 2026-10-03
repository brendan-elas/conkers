// conkers_script — the conker lock, spec/lock.md. Port of conkerLock() in
// mirror/src/script.ts; the bytes are checked against spec/vectors.json.
//
//   unlock:  <ownerSig | e2> <ownerPubKey> <preimage>
//   flags:   SIGHASH_NONE | ANYONECANPAY | CHRONICLE | FORKID = 0xE2 (OTDA digest)
//
// The brain only builds locks (mint, transfer). Preimages, digests and
// signatures stay in the mirror and the wallet.

const std = @import("std");
const ripemd160 = @import("conkers_ripemd160");
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const CONKERS_FLAG: u8 = 0xE2;

/// Upper bound on a lock: head with a 6-byte locktime push + separator + tail.
pub const MAX_LOCK = 640;

pub const Script = struct {
    buf: [MAX_LOCK]u8 = undefined,
    len: usize = 0,

    pub fn slice(self: *const Script) []const u8 {
        return self.buf[0..self.len];
    }
    fn append(self: *Script, bytes: []const u8) void {
        @memcpy(self.buf[self.len..][0..bytes.len], bytes);
        self.len += bytes.len;
    }
    fn op(self: *Script, b: u8) void {
        self.buf[self.len] = b;
        self.len += 1;
    }
    /// Raw pushdata with the right length prefix.
    fn push(self: *Script, data: []const u8) void {
        if (data.len <= 75) {
            self.op(@intCast(data.len));
        } else if (data.len <= 0xff) {
            self.op(0x4c);
            self.op(@intCast(data.len));
        } else {
            self.op(0x4d);
            self.op(@intCast(data.len & 0xff));
            self.op(@intCast(data.len >> 8));
        }
        self.append(data);
    }
    /// Push a number the minimal way (OP_0 / OP_1..16 / OP_1NEGATE / ScriptNum pushdata).
    fn pushNum(self: *Script, n: i64) void {
        if (n == 0) return self.op(0x00);
        if (n >= 1 and n <= 16) return self.op(0x50 + @as(u8, @intCast(n)));
        if (n == -1) return self.op(0x4f);
        var tmp: [9]u8 = undefined;
        self.push(scriptNum(n, &tmp));
    }
};

/// Minimal ScriptNum encoding (little-endian sign-magnitude).
pub fn scriptNum(n: i64, out: *[9]u8) []const u8 {
    if (n == 0) return out[0..0];
    const neg = n < 0;
    var a: u64 = @intCast(if (neg) -n else n);
    var len: usize = 0;
    while (a > 0) : (a >>= 8) {
        out[len] = @intCast(a & 0xff);
        len += 1;
    }
    if (out[len - 1] & 0x80 != 0) {
        out[len] = if (neg) 0x80 else 0x00;
        len += 1;
    } else if (neg) {
        out[len - 1] |= 0x80;
    }
    return out[0..len];
}

pub fn hash160(data: []const u8) [20]u8 {
    var h: [32]u8 = undefined;
    Sha256.hash(data, &h, .{});
    var out: [20]u8 = undefined;
    ripemd160.hash(&h, &out);
    return out;
}

fn hexLit(comptime s: []const u8) [s.len / 2]u8 {
    @setEvalBranchQuota(10_000);
    var out: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, s) catch unreachable;
    return out;
}

/// Brendogg's OP_PUSH_TX block, verbatim bytes of PUSHTX_ASM in mirror/src/script.ts
/// (vendor/semantos-core/core/wallet/src/tx/push-tx.ts). Takes the sighash flag from the
/// alt stack and leaves <sig> <pubkey> for OP_CHECKSIGVERIFY.
pub const PUSHTX = hexLit("aa517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e8100011f80517e9321414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff007d5296789f637897785296789f639467776867776876927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f76927f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e827c7e23022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798027c7e827c7e01307c7e6c7e2102b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0");

const OP_0: u8 = 0x00;
const OP_4: u8 = 0x54;
const OP_8: u8 = 0x58;
const OP_13: u8 = 0x5d;
const OP_VERIFY: u8 = 0x69;
const OP_TOALTSTACK: u8 = 0x6b;
const OP_FROMALTSTACK: u8 = 0x6c;
const OP_DROP: u8 = 0x75;
const OP_DUP: u8 = 0x76;
const OP_NIP: u8 = 0x77;
const OP_CAT: u8 = 0x7e;
const OP_SPLIT: u8 = 0x7f;
const OP_BIN2NUM: u8 = 0x81;
const OP_SIZE: u8 = 0x82;
const OP_EQUAL: u8 = 0x87;
const OP_EQUALVERIFY: u8 = 0x88;
const OP_NOT: u8 = 0x91;
const OP_SUB: u8 = 0x94;
const OP_GREATERTHANOREQUAL: u8 = 0xa2;
const OP_HASH160: u8 = 0xa9;
const OP_CODESEPARATOR: u8 = 0xab;
const OP_CHECKSIG: u8 = 0xac;
const OP_CHECKSIGVERIFY: u8 = 0xad;

/// Everything before the separator: pins on the pushed preimage (copied, then dropped).
fn lockHead(s: *Script, mint_locktime: u32) void {
    s.append(&.{ OP_DUP, OP_TOALTSTACK });
    // nVersion == 1
    s.append(&.{ OP_DUP, OP_4, OP_SPLIT, OP_DROP });
    s.push(&.{ 0x01, 0x00, 0x00, 0x00 });
    s.op(OP_EQUALVERIFY);
    // sighash type == e2000000 (last 4 bytes)
    s.append(&.{ OP_DUP, OP_SIZE, OP_4, OP_SUB, OP_SPLIT, OP_NIP });
    s.push(&.{ CONKERS_FLAG, 0x00, 0x00, 0x00 });
    s.op(OP_EQUALVERIFY);
    // nLocktime (bytes len-8 .. len-4) >= mintLocktime; 00 appended so the number is positive
    s.append(&.{ OP_DUP, OP_SIZE, OP_8, OP_SUB, OP_SPLIT, OP_NIP, OP_4, OP_SPLIT, OP_DROP });
    s.push(&.{0x00});
    s.append(&.{ OP_CAT, OP_BIN2NUM });
    s.pushNum(mint_locktime);
    s.append(&.{ OP_GREATERTHANOREQUAL, OP_VERIFY });
    // nSequence (bytes len-13 .. len-9: before the 00 output count) != ffffffff
    s.append(&.{ OP_SIZE, OP_13, OP_SUB, OP_SPLIT, OP_NIP, OP_4, OP_SPLIT, OP_DROP });
    s.push(&.{ 0xff, 0xff, 0xff, 0xff });
    s.append(&.{ OP_EQUAL, OP_NOT, OP_VERIFY });
}

/// Everything after the separator: this is the scriptCode both signatures sign.
pub fn lockTail(s: *Script, owner_pkh: [20]u8) void {
    s.op(OP_FROMALTSTACK);
    s.push(&.{CONKERS_FLAG});
    s.op(OP_TOALTSTACK);
    s.append(&PUSHTX);
    s.op(OP_CHECKSIGVERIFY);
    s.append(&.{ OP_DUP, OP_HASH160 });
    s.push(&owner_pkh);
    s.append(&.{ OP_EQUALVERIFY, OP_CHECKSIG });
}

pub fn conkerLock(owner_pkh: [20]u8, mint_locktime: u32) Script {
    var s = Script{};
    lockHead(&s, mint_locktime);
    s.op(OP_CODESEPARATOR);
    lockTail(&s, owner_pkh);
    return s;
}

// ─── Tests (the full lock bytes are checked against spec/vectors.json in vectors_test.zig) ───

const testing = std.testing;

test "scriptNum is minimal little-endian sign-magnitude" {
    var buf: [9]u8 = undefined;
    try testing.expectEqualSlices(u8, &.{}, scriptNum(0, &buf));
    try testing.expectEqualSlices(u8, &.{0x7f}, scriptNum(127, &buf));
    try testing.expectEqualSlices(u8, &.{ 0x80, 0x00 }, scriptNum(128, &buf));
    try testing.expectEqualSlices(u8, &.{ 0x80, 0x80 }, scriptNum(-128, &buf));
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x35, 0x0c }, scriptNum(800000, &buf));
}

test "pushNum uses the small-integer opcodes" {
    var s = Script{};
    s.pushNum(0);
    s.pushNum(5);
    s.pushNum(16);
    s.pushNum(17);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x55, 0x60, 0x01, 0x11 }, s.slice());
}

test "the lock starts with the preimage pins and ends with the owner check" {
    const pkh = [_]u8{0xab} ** 20;
    const l = conkerLock(pkh, 800000);
    try testing.expectEqual(@as(usize, 520), l.len);
    try testing.expectEqualSlices(u8, &.{ OP_DUP, OP_TOALTSTACK, OP_DUP, OP_4, OP_SPLIT, OP_DROP, 0x04, 0x01, 0x00, 0x00, 0x00, OP_EQUALVERIFY }, l.slice()[0..12]);
    try testing.expectEqualSlices(u8, &.{ OP_EQUALVERIFY, OP_CHECKSIG }, l.slice()[l.len - 2 ..]);
    try testing.expectEqual(@as(u8, OP_CODESEPARATOR), l.slice()[59]);
    try testing.expectEqual(@as(usize, 518), conkerLock(pkh, 101).len); // the regtest lock
}

test "hash160 of a known key" {
    // hash160(02 || 79be66..f81798) = the P2PKH of the generator point's compressed key.
    const g = hexLit("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    try testing.expectEqualSlices(u8, &hexLit("751e76e8199196d454941c45d1b3a323f1433bd6"), &hash160(&g));
}
