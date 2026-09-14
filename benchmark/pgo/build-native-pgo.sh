#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "build-native-pgo.sh is supported only on Linux" >&2
  exit 1
fi

CLANG=${SWM_PGO_CC:-clang-18}
CLANGXX=${SWM_PGO_CXX:-clang++-18}
PROFDATA=${SWM_PGO_PROFDATA:-llvm-profdata-18}
CONNECTIONS=${SWM_PGO_CONNECTIONS:-100}
PROFILE=${SWM_PGO_PROFILE:-balanced}
GET_COUNT=${SWM_PGO_GET_COUNT:-1000000}
POST_COUNT=${SWM_PGO_POST_COUNT:-250000}
WS_COUNT=${SWM_PGO_WS_COUNT:-500000}
PORT=${SWM_PGO_PORT:-0}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROFILE_DIR=${SWM_PGO_EVIDENCE_DIR:-$ROOT/pgo-evidence}
mkdir -p "$PROFILE_DIR"
PROFILE_DIR=$(realpath "$PROFILE_DIR")
if [[ -n "$(ls -A "$PROFILE_DIR")" ]]; then
  echo "PGO evidence directory must be empty: $PROFILE_DIR" >&2
  exit 1
fi
mkdir "$PROFILE_DIR/validation"
SERVER_LOG="$PROFILE_DIR/server.log"
SERVER_METRICS="$PROFILE_DIR/runtime.json"

for command in "$CLANG" "$CLANGXX" "$PROFDATA" node npm curl; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid"
    wait "$server_pid" || true
  fi
  echo "PGO evidence retained: $PROFILE_DIR"
}
trap cleanup EXIT INT TERM

if [[ "$PROFILE" != "synthetic" && "$PROFILE" != "balanced" ]]; then
  echo "SWM_PGO_PROFILE must be synthetic or balanced" >&2
  exit 1
fi

instrument_flag="-fprofile-instr-generate=$PROFILE_DIR/default.profraw"
CC="$CLANG" CXX="$CLANGXX" \
  CFLAGS="$instrument_flag" CXXFLAGS="$instrument_flag" LDFLAGS="$instrument_flag" \
  npm run build:native

LLVM_PROFILE_FILE="$PROFILE_DIR/validation/smoke-%p.profraw" npm test
LLVM_PROFILE_FILE="$PROFILE_DIR/validation/http-%p.profraw" npm run test:v8-http
LLVM_PROFILE_FILE="$PROFILE_DIR/validation/ws-%p.profraw" npm run test:v8-ws

LLVM_PROFILE_FILE="$PROFILE_DIR/server-%p.profraw" \
SWM_PROFILE_METRICS="$SERVER_METRICS" \
SWM_PROFILE_PORT="$PORT" \
  node "$ROOT/benchmark/pgo/profile-http-raw-server.js" >"$SERVER_LOG" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 100); do
  listening_port=$(sed -n 's|^ready http://127.0.0.1:\([0-9]*\)/base$|\1|p' "$SERVER_LOG")
  if [[ -n "$listening_port" ]]; then
    PORT=$listening_port
    curl -fsS "http://127.0.0.1:$PORT/base" >/dev/null
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ "$ready" != "1" ]]; then
  echo "PGO training server did not become ready" >&2
  exit 1
fi

node "$ROOT/benchmark/pgo/train-fixed-work.js" GET "$PORT" "$GET_COUNT" "$CONNECTIONS" >"$PROFILE_DIR/training-get.json"
if [[ "$PROFILE" == "balanced" ]]; then
  node "$ROOT/benchmark/pgo/train-fixed-work.js" POST "$PORT" "$POST_COUNT" "$CONNECTIONS" >"$PROFILE_DIR/training-post.json"
  node "$ROOT/benchmark/pgo/train-fixed-work.js" WS "$PORT" "$WS_COUNT" "$CONNECTIONS" 1 >"$PROFILE_DIR/training-ws-closed.json"
  node "$ROOT/benchmark/pgo/train-fixed-work.js" WS "$PORT" "$WS_COUNT" "$CONNECTIONS" 16 >"$PROFILE_DIR/training-ws-depth16.json"
fi

kill -TERM "$server_pid"
wait "$server_pid"
server_pid=''

"$PROFDATA" merge -output="$PROFILE_DIR/swm.profdata" "$PROFILE_DIR"/server-*.profraw

use_flags="-fprofile-instr-use=$PROFILE_DIR/swm.profdata -Wno-profile-instr-unprofiled"
CC="$CLANG" CXX="$CLANGXX" \
  CFLAGS="$use_flags" CXXFLAGS="$use_flags" LDFLAGS="-fprofile-instr-use=$PROFILE_DIR/swm.profdata" \
  npm run build:native

cp "$ROOT/prebuilds/linux-x64-glibc/node-v$(node -p 'process.versions.modules').node" "$PROFILE_DIR/candidate.node"
"$CLANG" --version >"$PROFILE_DIR/toolchain.txt"
node -p 'JSON.stringify({node:process.version,versions:process.versions})' >"$PROFILE_DIR/node.json"
(cd "$ROOT" && find src vendor -type f -print0 | sort -z | xargs -0 sha256sum; sha256sum binding.gyp package-lock.json benchmark/pgo/build-native-pgo.sh benchmark/pgo/train-fixed-work.js) >"$PROFILE_DIR/source-files.sha256"
(cd "$PROFILE_DIR" && sha256sum ./*.profraw ./validation/*.profraw ./*.profdata ./*.json ./*.node ./*.txt source-files.sha256 > SHA256SUMS)
echo "PGO build complete: profile=$PROFILE get=$GET_COUNT post=$POST_COUNT ws=$WS_COUNT"
