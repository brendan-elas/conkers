// Proves the conker lock on a Chronicle regtest node (scripts/regtest.sh start first).
//   1. mint: two conkerLock outputs, funded and signed by the node wallet
//   2. transfer: spend the nut under 0xE2 with a node-wallet fee input added AFTER our
//      signature (ANYONECANPAY | NONE lets the wallet add inputs and change freely)
//   3. negatives: version 2, locktime below the floor, final sequence → node must reject
// Run: pnpm --filter @conkers/mirror regtest   (RPC_URL=http://user:pass@host:port)
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { conkerLock, conkerUnlock, hash160, hex, unhex, asm } from '../src/script.ts';
import { parseTx, serializeTx, txidHex, txidToWire, type FullTx } from '../src/otda.ts';

const RPC_URL = process.env['RPC_URL'] ?? 'http://bitcoin:bitcoin@127.0.0.1:18443';
let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const u = new URL(RPC_URL);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = ''; u.password = '';
  const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` }, body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }) });
  const body = (await res.json()) as { result: T; error: { code: number; message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result;
}
const expectReject = async (label: string, hexTx: string, pattern: RegExp) => {
  try { await rpc('sendrawtransaction', [hexTx]); throw new Error(`${label}: node ACCEPTED a transaction it must reject`); }
  catch (e) { const m = (e as Error).message; if (!pattern.test(m)) throw new Error(`${label}: rejected for the wrong reason: ${m}`); console.log(`  rejected as expected: ${label} (${m.split('(')[0]!.trim()})`); }
};

// Pick a mature wallet coin, append it as an input and a change output. Fee 1000 sat (node min is 1 sat/kB).
async function addFeeInput(tx: FullTx, changeAddr: string): Promise<{ txid: string; vout: number }> {
  const coins = await rpc<{ txid: string; vout: number; amount: number; confirmations: number; spendable: boolean }[]>('listunspent', [1]);
  const coin = coins.find((c) => c.spendable && c.amount >= 1);
  if (!coin) throw new Error('wallet has no mature coin for the fee');
  const inSats = BigInt(Math.round(coin.amount * 1e8));
  const outSats = tx.outputs.reduce((a, o) => a + o.satoshis, 0n);
  const conkerSats = 1000n * BigInt(tx.inputs.length); // every conker input in this harness carries 1000 sat
  const change = inSats + conkerSats - outSats - 1000n;
  tx.inputs.push({ prevTxId: txidToWire(coin.txid), prevIndex: coin.vout, sequence: 0xfffffffe, scriptSig: new Uint8Array(0) });
  const changeScript = unhex((await rpc<{ scriptPubKey: string }>('validateaddress', [changeAddr])).scriptPubKey);
  tx.outputs.push({ satoshis: change, script: changeScript });
  return { txid: coin.txid, vout: coin.vout };
}

async function main() {
  const height0 = await rpc<number>('getblockcount');
  const addr = await rpc<string>('getnewaddress');
  if (height0 < 110) { console.log(`mining ${110 - height0} blocks for coinbase maturity`); await rpc('generatetoaddress', [110 - height0, addr]); }
  let height = await rpc<number>('getblockcount');
  console.log(`regtest height ${height}, chronicle active from 1`);

  const ownerPriv = sha256(new TextEncoder().encode('regtest-owner')), ownerPub = secp256k1.getPublicKey(ownerPriv, true);
  const nextPriv = sha256(new TextEncoder().encode('regtest-next-owner')), nextPub = secp256k1.getPublicKey(nextPriv, true);
  const mintLocktime = height - 10;
  const lock = { ownerPkh: hash160(ownerPub), mintLocktime };
  const lockHex = hex(conkerLock(lock));

  // 1. mint: two outputs (nut, string) under the same lock, 1000 sat each
  const SATS = 1000;
  const mintBody: FullTx = { version: 1, inputs: [], outputs: [{ satoshis: BigInt(SATS), script: unhex(lockHex) }, { satoshis: BigInt(SATS), script: unhex(lockHex) }], lockTime: 0 };
  const funded = await rpc<{ hex: string }>('fundrawtransaction', [hex(serializeTx(mintBody)), { changePosition: 2 }]);
  const signed = await rpc<{ hex: string; complete: boolean }>('signrawtransactionwithwallet', [funded.hex]).catch(() => rpc<{ hex: string; complete: boolean }>('signrawtransaction', [funded.hex]));
  if (!signed.complete) throw new Error('wallet could not sign the mint');
  const mintTxid = await rpc<string>('sendrawtransaction', [signed.hex]);
  await rpc('generatetoaddress', [1, addr]); height++;
  console.log(`mint ${mintTxid} confirmed: nut = :0, string = :1, ${SATS} sat each, lock ${lockHex.length / 2} bytes`);

  // 2. transfer the nut under 0xE2. Our input first; outputs are ours to choose (NONE = unsigned).
  const nextLock = conkerLock({ ownerPkh: hash160(nextPub), mintLocktime: height - 1 });
  const spendBody: FullTx = {
    version: 1,
    inputs: [{ prevTxId: txidToWire(mintTxid), prevIndex: 0, sequence: 0xfffffffe, scriptSig: new Uint8Array(0) }],
    outputs: [{ satoshis: BigInt(SATS), script: nextLock }],
    lockTime: height - 1,
  };
  // sign OUR input first, with no fee input present…
  const sign = (tx: FullTx) => conkerUnlock({ tx, inputIndex: 0, lock, ownerPriv });
  spendBody.inputs[0]!.scriptSig = sign(spendBody);
  // …then add a wallet fee input and change. ANYONECANPAY | NONE: our signature stays valid.
  // Not fundrawtransaction: this sv-node build dummy-signs every existing input to size the fee
  // and fails on ours ("Signing transaction failed"), so the fee input is picked by hand.
  const fee = await addFeeInput(spendBody, addr);
  const walletSigned = await rpc<{ hex: string; complete: boolean; errors?: { vout: number; error: string }[] }>('signrawtransactionwithwallet', [hex(serializeTx(spendBody))]).catch(() => rpc<{ hex: string; complete: boolean; errors?: { vout: number; error: string }[] }>('signrawtransaction', [hex(serializeTx(spendBody))]));
  const finalTx = parseTx(unhex(walletSigned.hex));
  if (finalTx.inputs.length < 2) throw new Error('fee input missing');
  if (hex(finalTx.inputs[0]!.scriptSig) !== hex(spendBody.inputs[0]!.scriptSig)) throw new Error('wallet rewrote our unlocking script');
  if (finalTx.inputs[1]!.scriptSig.length === 0) throw new Error(`wallet did not sign the fee input: ${JSON.stringify(walletSigned.errors ?? [])}`);
  console.log(`  fee input ${fee.txid}:${fee.vout} added after our signature (wallet reports complete=${walletSigned.complete}; input 0 is not its key)`);
  const spendTxid = await rpc<string>('sendrawtransaction', [walletSigned.hex]);
  await rpc('generatetoaddress', [1, addr]); height++;
  console.log(`transfer ${spendTxid} confirmed with ${finalTx.inputs.length} inputs and ${finalTx.outputs.length} outputs: 0xE2 OTDA spend accepted by the node`);

  // 3. negatives on the string output (:1), each a fresh tx signed for its own (wrong) parameters
  const neg = (mutate: (t: FullTx) => void): string => {
    const t: FullTx = { version: 1, inputs: [{ prevTxId: txidToWire(mintTxid), prevIndex: 1, sequence: 0xfffffffe, scriptSig: new Uint8Array(0) }], outputs: [{ satoshis: BigInt(SATS) - 200n, script: asm('OP_TRUE') }], lockTime: height - 1 };
    mutate(t); t.inputs[0]!.scriptSig = sign(t); return hex(serializeTx(t));
  };
  await expectReject('nVersion = 2', neg((t) => { t.version = 2; }), /script|mandatory|Script/i);
  await expectReject('locktime below mint floor', neg((t) => { t.lockTime = mintLocktime - 1; }), /script|mandatory|Script/i);
  await expectReject('final sequence', neg((t) => { t.inputs[0]!.sequence = 0xffffffff; }), /script|mandatory|Script/i);
  const okStr = neg(() => {});
  const strTxid = await rpc<string>('sendrawtransaction', [okStr]);
  console.log(`string spent too: ${strTxid}`);
  console.log('\nALL GREEN: mint, 0xE2 transfer with a third-party fee input, three rejections, string spend.');
}
main().catch((e) => { console.error(e); process.exit(1); });
