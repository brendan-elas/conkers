#!/usr/bin/env bash
# Chronicle regtest node for proving the conker lock. Adapted from runar/integration/regtest.sh.
#   scripts/regtest.sh start | stop | clean | cli <args>
# Then: pnpm --filter @conkers/mirror regtest   (RPC_URL defaults to http://bitcoin:bitcoin@127.0.0.1:18443)
set -euo pipefail
NAME=conkers-regtest; RPC_PORT=${RPC_PORT:-18443}; P2P_PORT=${P2P_PORT:-18444}
DIR="$(cd "$(dirname "$0")/.." && pwd)/.regtest"; CMD=${1:-}; shift || true
case "$CMD" in
  start)
    mkdir -p "$DIR/regtest"
    cat > "$DIR/bitcoin.conf" <<CONF
regtest=1
server=1
txindex=1
listen=0
rpcbind=0.0.0.0
rpcport=$RPC_PORT
rpcuser=bitcoin
rpcpassword=bitcoin
rpcallowip=0.0.0.0/0
port=$P2P_PORT
excessiveblocksize=1000000000
maxstackmemoryusageconsensus=100000000
maxscriptsizepolicy=0
maxscriptnumlengthpolicy=0
maxstackmemoryusagepolicy=100000000
maxtxsizepolicy=0
genesisactivationheight=1
chronicleactivationheight=1
minminingtxfee=0.00000001
acceptnonstdtxn=0
CONF
    docker rm -f $NAME >/dev/null 2>&1 || true
    docker run --platform linux/amd64 --name $NAME -p $RPC_PORT:$RPC_PORT -v "$DIR":/data -d bitcoinsv/bitcoin-sv:latest bitcoind -conf=/data/bitcoin.conf -printtoconsole >/dev/null
    for i in $(seq 1 30); do docker exec $NAME bitcoin-cli -conf=/data/bitcoin.conf getblockcount >/dev/null 2>&1 && { echo "$NAME up on rpc $RPC_PORT"; exit 0; }; sleep 1; done
    echo "node did not come up"; docker logs $NAME | tail -20; exit 1 ;;
  stop)  docker rm -f $NAME ;;
  clean) docker rm -f $NAME >/dev/null 2>&1 || true; rm -rf "$DIR"; echo cleaned ;;
  cli)   docker exec $NAME bitcoin-cli -conf=/data/bitcoin.conf "$@" ;;
  *) echo "usage: $0 start|stop|clean|cli <args>"; exit 2 ;;
esac
