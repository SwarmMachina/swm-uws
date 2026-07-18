#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "benchmark-pgo-compare-linux.sh requires native Linux x86-64" >&2
  exit 1
fi

: "${SWM_BENCH_REFERENCE:?SWM_BENCH_REFERENCE must point to upstream ESM_wrapper.mjs}"

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=$(realpath -m "$1")
RAW_DIR=$(mktemp -d "${TMPDIR:-/tmp}/swm-uws-benchmark.XXXXXX")
NODE_MODULE_VERSION=${NODE_MODULE_VERSION:-$(node -p 'process.versions.modules')}
RUNS=${SWM_BENCH_RUNS:-6}
CONNECTIONS=${SWM_BENCH_CONNECTIONS:-100}
PIPELINING=${SWM_BENCH_PIPELINING:-10}
WARMUP=${SWM_BENCH_WARMUP:-2}
DURATION=${SWM_BENCH_DURATION:-5}
SERVER_CPU=${SWM_BENCH_SERVER_CPU:-2}
CLIENT_CPUS=${SWM_BENCH_CLIENT_CPUS:-3-6}
CLIENT_WORKERS=${SWM_BENCH_CLIENT_WORKERS:-4}
PORT_BASE=${SWM_BENCH_PORT_BASE:-32000}
SKIP_PERF=${SWM_BENCH_SKIP_PERF:-0}
CANDIDATE_BINARY=${SWM_BENCH_BINARY:-$ROOT/prebuilds/linux-x64-glibc/node-v${NODE_MODULE_VERSION}.node}
LOCAL_BINDING="$ROOT/lib/index.js"

cleanup() {
  rm -rf "$RAW_DIR"
}
trap cleanup EXIT INT TERM

test -f "$CANDIDATE_BINARY" || {
  echo "candidate binary not found: $CANDIDATE_BINARY" >&2
  exit 1
}
test -f "$SWM_BENCH_REFERENCE" || {
  echo "upstream binding not found: $SWM_BENCH_REFERENCE" >&2
  exit 1
}
if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 2 || RUNS % 2 != 0 )); then
  echo "SWM_BENCH_RUNS must be an even integer of at least 2" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

run_profile() {
  local side=$1
  local binding=$2
  local round=$3
  local port=$4

  echo "benchmark round=$round side=$side c=$CONNECTIONS p=$PIPELINING warmup=${WARMUP}s duration=${DURATION}s"
  SWM_PROFILE_BINDING="$binding" \
  SWM_PROFILE_WARMUP="$WARMUP" \
  SWM_PROFILE_DURATION="$DURATION" \
  SWM_PROFILE_CONNECTIONS="$CONNECTIONS" \
  SWM_PROFILE_PIPELINING="$PIPELINING" \
  SWM_PROFILE_SERVER_CPU="$SERVER_CPU" \
  SWM_PROFILE_CLIENT_CPUS="$CLIENT_CPUS" \
  SWM_PROFILE_CLIENT_WORKERS="$CLIENT_WORKERS" \
  SWM_PROFILE_SKIP_PERF=1 \
    "$ROOT/scripts/profile-http-raw-linux.sh" "$RAW_DIR/round-$round-$side" "$port" >/dev/null
}

for round in $(seq 1 "$RUNS"); do
  swm_port=$((PORT_BASE + round * 2))
  uws_port=$((swm_port + 1))
  if (( round % 2 == 1 )); then
    run_profile swm "$LOCAL_BINDING" "$round" "$swm_port"
    run_profile uws "$SWM_BENCH_REFERENCE" "$round" "$uws_port"
  else
    run_profile uws "$SWM_BENCH_REFERENCE" "$round" "$uws_port"
    run_profile swm "$LOCAL_BINDING" "$round" "$swm_port"
  fi
done

if [[ "$SKIP_PERF" == "1" ]]; then
  cp -R "$RAW_DIR/round-$RUNS-swm" "$RAW_DIR/hardware"
  HARDWARE_SOURCE="paired round $RUNS; counters unavailable"
else
  echo "hardware stat side=swm c=$CONNECTIONS p=$PIPELINING warmup=${WARMUP}s duration=${DURATION}s"
  SWM_PROFILE_BINDING="$LOCAL_BINDING" \
  SWM_PROFILE_WARMUP="$WARMUP" \
  SWM_PROFILE_DURATION="$DURATION" \
  SWM_PROFILE_CONNECTIONS="$CONNECTIONS" \
  SWM_PROFILE_PIPELINING="$PIPELINING" \
  SWM_PROFILE_SERVER_CPU="$SERVER_CPU" \
  SWM_PROFILE_CLIENT_CPUS="$CLIENT_CPUS" \
  SWM_PROFILE_CLIENT_WORKERS="$CLIENT_WORKERS" \
  SWM_PROFILE_SKIP_PERF=0 \
    "$ROOT/scripts/profile-http-raw-linux.sh" "$RAW_DIR/hardware" "$PORT_BASE" >/dev/null
  HARDWARE_SOURCE="independent stat-only run"
fi

SWM_BENCH_RUNS="$RUNS" \
SWM_BENCH_CONNECTIONS="$CONNECTIONS" \
SWM_BENCH_PIPELINING="$PIPELINING" \
SWM_BENCH_WARMUP="$WARMUP" \
SWM_BENCH_DURATION="$DURATION" \
SWM_BENCH_SERVER_CPU="$SERVER_CPU" \
SWM_BENCH_CLIENT_CPUS="$CLIENT_CPUS" \
SWM_BENCH_CLIENT_WORKERS="$CLIENT_WORKERS" \
SWM_BENCH_HARDWARE_SOURCE="$HARDWARE_SOURCE" \
  node "$ROOT/scripts/collect-pgo-benchmark.js" "$RAW_DIR" "$OUT_DIR" "$CANDIDATE_BINARY"

cp "$RAW_DIR/hardware/perf-stat.csv" "$OUT_DIR/perf-stat.csv"
node "$ROOT/scripts/generate-pgo-report.js" --directory "$OUT_DIR"
node "$ROOT/scripts/check-pgo-benchmark.js" "$OUT_DIR"

echo "paired PGO benchmark complete: $OUT_DIR"
