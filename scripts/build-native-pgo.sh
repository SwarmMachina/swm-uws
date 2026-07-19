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
PIPELINING=${SWM_PGO_PIPELINING:-10}
PROFILE=${SWM_PGO_PROFILE:-balanced}
GET_DURATION=${SWM_PGO_GET_DURATION:-10}
POST_DURATION=${SWM_PGO_POST_DURATION:-4}
SNAPSHOT_DURATION=${SWM_PGO_SNAPSHOT_DURATION:-4}
SNAPSHOT_PIPELINING=${SWM_PGO_SNAPSHOT_PIPELINING:-1}
SNAPSHOT_VARIANTS=${SWM_PGO_SNAPSHOT_VARIANTS:-24}
WS_DURATION=${SWM_PGO_WS_DURATION:-4}
WORKERS=${SWM_PGO_WORKERS:-4}
PORT=${SWM_PGO_PORT:-30991}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROFILE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swm-uws-pgo.XXXXXX")
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
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT INT TERM

if [[ "$PROFILE" != "synthetic" && "$PROFILE" != "balanced" ]]; then
  echo "SWM_PGO_PROFILE must be synthetic or balanced" >&2
  exit 1
fi

snapshot_summary=disabled
if [[ "$PROFILE" == "balanced" ]]; then
  if ! [[ "$SNAPSHOT_DURATION" =~ ^[1-9][0-9]*$ ]] ||
    ! [[ "$SNAPSHOT_PIPELINING" =~ ^[1-9][0-9]*$ ]] ||
    ! [[ "$SNAPSHOT_VARIANTS" =~ ^(1[6-9]|2[0-9]|3[0-2])$ ]]; then
    echo "snapshot PGO settings require positive duration/pipelining and 16-32 variants" >&2
    exit 1
  fi
  snapshot_summary="${SNAPSHOT_DURATION}s/c${CONNECTIONS}/p${SNAPSHOT_PIPELINING}/v${SNAPSHOT_VARIANTS}"
fi

instrument_flag="-fprofile-instr-generate=$PROFILE_DIR/default.profraw"
CC="$CLANG" CXX="$CLANGXX" \
  CFLAGS="$instrument_flag" CXXFLAGS="$instrument_flag" LDFLAGS="$instrument_flag" \
  npm run build:native

LLVM_PROFILE_FILE="$PROFILE_DIR/smoke-%p.profraw" npm test
LLVM_PROFILE_FILE="$PROFILE_DIR/http-%p.profraw" npm run test:v8-http
LLVM_PROFILE_FILE="$PROFILE_DIR/snapshot-shapes-%p.profraw" npm run test:v8-snapshot-shapes
LLVM_PROFILE_FILE="$PROFILE_DIR/ws-%p.profraw" npm run test:v8-ws

LLVM_PROFILE_FILE="$PROFILE_DIR/server-%p.profraw" \
SWM_PROFILE_METRICS="$SERVER_METRICS" \
SWM_PROFILE_PORT="$PORT" \
  node "$ROOT/scripts/profile-http-raw-server.js" >"$SERVER_LOG" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/base" >/dev/null 2>&1; then
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

node "$ROOT/scripts/profile-http-raw-load.js" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --connections "$CONNECTIONS" \
  --pipelining "$PIPELINING" \
  --duration "$GET_DURATION" \
  --workers "$WORKERS" \
  >"$PROFILE_DIR/training-get.json"

if [[ "$PROFILE" == "balanced" ]]; then
  node "$ROOT/scripts/profile-http-raw-load.js" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --method POST \
    --path /post \
    --bodySize 256 \
    --connections "$CONNECTIONS" \
    --pipelining "$PIPELINING" \
    --duration "$POST_DURATION" \
    --workers "$WORKERS" \
    >"$PROFILE_DIR/training-post.json"

  node "$ROOT/scripts/profile-http-raw-load.js" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --path /snapshot \
    --connections "$CONNECTIONS" \
    --pipelining "$SNAPSHOT_PIPELINING" \
    --headerVariants "$SNAPSHOT_VARIANTS" \
    --duration "$SNAPSHOT_DURATION" \
    --workers "$WORKERS" \
    >"$PROFILE_DIR/training-snapshot.json"

  PORT="$PORT" CONNECTIONS="$CONNECTIONS" DEPTH=1 \
    DURATION_MS="$((WS_DURATION * 1000))" node "$ROOT/scripts/bench-ws.js" \
    >"$PROFILE_DIR/training-ws-closed.json"
  PORT="$PORT" CONNECTIONS="$CONNECTIONS" DEPTH=16 \
    DURATION_MS="$((WS_DURATION * 1000))" node "$ROOT/scripts/bench-ws.js" \
    >"$PROFILE_DIR/training-ws-depth16.json"
fi

kill -TERM "$server_pid"
wait "$server_pid"
server_pid=''

"$PROFDATA" merge -output="$PROFILE_DIR/swm.profdata" "$PROFILE_DIR"/*.profraw

use_flags="-fprofile-instr-use=$PROFILE_DIR/swm.profdata -Wno-profile-instr-unprofiled"
CC="$CLANG" CXX="$CLANGXX" \
  CFLAGS="$use_flags" CXXFLAGS="$use_flags" LDFLAGS="-fprofile-instr-use=$PROFILE_DIR/swm.profdata" \
  npm run build:native

echo "PGO build complete: profile=$PROFILE c=$CONNECTIONS p=$PIPELINING get=${GET_DURATION}s snapshot=$snapshot_summary workers=$WORKERS"
