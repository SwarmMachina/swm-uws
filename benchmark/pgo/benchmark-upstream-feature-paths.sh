#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <out-dir>" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "benchmark-upstream-feature-paths.sh requires native Linux x86-64" >&2
  exit 1
fi

: "${SWM_BENCH_REFERENCE:?SWM_BENCH_REFERENCE must point to upstream ESM_wrapper.mjs}"

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT_DIR=$(realpath -m "$1")
NODE_MODULE_VERSION=${NODE_MODULE_VERSION:-$(node -p 'process.versions.modules')}
CANDIDATE_BINARY=${SWM_BENCH_BINARY:-$ROOT/prebuilds/linux-x64-glibc/node-v${NODE_MODULE_VERSION}.node}
RUNS=${SWM_BENCH_FEATURE_RUNS:-${SWM_BENCH_RUNS:-6}}
CONNECTIONS=${SWM_BENCH_FEATURE_CONNECTIONS:-${SWM_BENCH_CONNECTIONS:-100}}
WARMUP_MS=${SWM_BENCH_FEATURE_WARMUP_MS:-2000}
DURATION_MS=${SWM_BENCH_FEATURE_DURATION_MS:-5000}
WORKERS=${SWM_BENCH_FEATURE_WORKERS:-${SWM_BENCH_CLIENT_WORKERS:-4}}
SERVER_CPU=${SWM_BENCH_FEATURE_SERVER_CPU:-${SWM_BENCH_SERVER_CPU:-2}}
CLIENT_CPUS=${SWM_BENCH_FEATURE_CLIENT_CPUS:-${SWM_BENCH_CLIENT_CPUS:-3-6}}
MAX_BODY_SIZE=${SWM_BENCH_FEATURE_MAX_BODY_SIZE:-67108864}
RUNNER="$ROOT/benchmark/benchmark-upstream-feature-paths.mjs"

for command in node realpath taskset; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

test -f "$RUNNER" || {
  echo "feature benchmark runner not found: $RUNNER" >&2
  exit 1
}
test -f "$CANDIDATE_BINARY" || {
  echo "candidate binary not found: $CANDIDATE_BINARY" >&2
  exit 1
}
test -f "$SWM_BENCH_REFERENCE" || {
  echo "upstream binding not found: $SWM_BENCH_REFERENCE" >&2
  exit 1
}
if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 2 || RUNS % 2 != 0 )); then
  echo "SWM_BENCH_FEATURE_RUNS must be an even integer of at least 2" >&2
  exit 1
fi
for value in "$CONNECTIONS" "$WARMUP_MS" "$DURATION_MS" "$WORKERS" "$MAX_BODY_SIZE"; do
  if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "feature benchmark parameters must be positive integers" >&2
    exit 1
  fi
done
if ! [[ "$SERVER_CPU" =~ ^-?[0-9]+$ ]] || (( SERVER_CPU < -1 )); then
  echo "SWM_BENCH_FEATURE_SERVER_CPU must be -1 or a non-negative CPU index" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

run_feature() {
  local name=$1
  local feature=$2
  local body_size=$3
  local pipelining=$4
  local output="$OUT_DIR/$name.json"

  echo "feature benchmark=$name feature=$feature body=${body_size}B c=$CONNECTIONS p=$pipelining warmup=${WARMUP_MS}ms duration=${DURATION_MS}ms"
  taskset -c "$CLIENT_CPUS" node "$RUNNER" \
    --feature="$feature" \
    --swmBinding="$ROOT/lib/index.js" \
    --upstreamBinding="$SWM_BENCH_REFERENCE" \
    --output="$output" \
    --bodySize="$body_size" \
    --maxBodySize="$MAX_BODY_SIZE" \
    --blocks="$RUNS" \
    --connections="$CONNECTIONS" \
    --pipelining="$pipelining" \
    --warmupMs="$WARMUP_MS" \
    --durationMs="$DURATION_MS" \
    --workers="$WORKERS" \
    --serverCpu="$SERVER_CPU"
}

run_feature collect-body-with-length-256 collect-length 256 10
run_feature collect-body-with-length-4096 collect-length 4096 10
run_feature end-batch end-batch 256 10
run_feature request-prefetch prefetch 256 1
run_feature discard-body discard-body 4096 1

echo "upstream feature benchmark suite complete: $OUT_DIR"
