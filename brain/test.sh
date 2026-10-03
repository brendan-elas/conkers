#!/usr/bin/env bash
# Runs the brain's Zig tests without the brain: plain `zig test` with the same
# module graph build.zon declares. The brain itself (Zig 0.15.2) runs them via
#   cd vendor/semantos-core/runtime/semantos-brain && zig build test -Dcartridge=/abs/path/conkers
# Usage: brain/test.sh [zig]
#
# Under a newer Zig (0.16: `std.ArrayList(u8){}` became `.empty`) the vendored
# brain modules do not compile. This script then patches that one initialiser
# in a scratch copy of the three brain files it needs (verb_dispatcher,
# cartridge_spec, cell_store) and says so. Our own files use `.empty`, which
# both versions accept. The submodule is never written to.
set -euo pipefail
ZIG=${1:-zig}
cd "$(dirname "$0")"
CORE=../vendor/semantos-core/core/cell-engine/src
BRAIN=../vendor/semantos-core/runtime/semantos-brain

DISPATCHER=$BRAIN/src/verb_dispatcher.zig
SPEC=$BRAIN/cartridge_spec.zig
CELL_STORE=$BRAIN/src/lmdb/cell_store.zig
if ! "$ZIG" test -Mroot="$DISPATCHER" >/dev/null 2>&1; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  for f in "$DISPATCHER" "$SPEC" "$CELL_STORE"; do
    sed 's/= \.{},$/= .empty,/' "$f" > "$TMP/$(basename "$f")"
  done
  DISPATCHER=$TMP/verb_dispatcher.zig; SPEC=$TMP/cartridge_spec.zig; CELL_STORE=$TMP/cell_store.zig
  echo "note: $("$ZIG" version) cannot compile the vendored brain modules; testing against a patched scratch copy (ArrayList init). The brain's own build under 0.15.2 is the real run."
fi

# A module's -M line must follow the --dep lines of everything it imports.
ripemd=(-Mconkers_ripemd160=$CORE/ripemd160.zig)
derive=(-Mconkers_derive=derive.zig)
cellsm=(-Mconkers_cells=cells.zig)
physics=(--dep conkers_derive -Mconkers_physics=physics.zig)
scriptm=(--dep conkers_ripemd160 -Mconkers_script=script.zig)
verbs=(--dep conkers_derive --dep conkers_cells --dep conkers_physics --dep conkers_script -Mconkers_verbs=verbs.zig)
vectors=(-Mconkers_vectors=../spec/vectors.json)
dispatcher=(-Mverb_dispatcher=$DISPATCHER)
cell_store=(-Mcell_store=$CELL_STORE)
spec=(--dep verb_dispatcher --dep cell_store -Mcartridge_spec=$SPEC)
walkers=(--dep conkers_verbs --dep conkers_cells --dep conkers_vectors --dep verb_dispatcher -Mconkers_walkers=walkers.zig)
pure=("${derive[@]}" "${cellsm[@]}" "${physics[@]}" "${scriptm[@]}" "${ripemd[@]}")

run() { echo "== $1"; shift; "$ZIG" test "$@"; }

run derive  -Mroot=derive.zig
run cells   -Mroot=cells.zig
run physics --dep conkers_derive -Mroot=physics.zig "${derive[@]}"
run script  --dep conkers_ripemd160 -Mroot=script.zig "${ripemd[@]}"
run verbs   --dep conkers_derive --dep conkers_cells --dep conkers_physics --dep conkers_script -Mroot=verbs.zig "${pure[@]}"
run vectors --dep conkers_vectors --dep conkers_derive --dep conkers_cells --dep conkers_physics --dep conkers_script --dep conkers_verbs -Mroot=vectors_test.zig \
            "${vectors[@]}" "${pure[@]}" "${verbs[@]}"
run walkers --dep conkers_verbs --dep conkers_cells --dep conkers_vectors --dep verb_dispatcher -Mroot=walkers.zig \
            "${verbs[@]}" "${pure[@]}" "${vectors[@]}" "${dispatcher[@]}"
run boot    --dep verb_dispatcher --dep cartridge_spec --dep conkers_walkers -Mroot=boot_spec.zig \
            "${dispatcher[@]}" "${spec[@]}" "${cell_store[@]}" "${walkers[@]}" "${verbs[@]}" "${pure[@]}" "${vectors[@]}"
echo "brain: all modules green"
