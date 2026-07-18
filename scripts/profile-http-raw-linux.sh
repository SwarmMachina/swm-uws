#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <out-dir> [port]" >&2
  exit 2
fi

OUT_DIR=$(realpath -m "$1")
PORT=${2:-3000}
WARMUP=${SWM_PROFILE_WARMUP:-2}
DURATION=${SWM_PROFILE_DURATION:-5}
CONNECTIONS=${SWM_PROFILE_CONNECTIONS:-100}
PIPELINING=${SWM_PROFILE_PIPELINING:-10}
SERVER_CPU=${SWM_PROFILE_SERVER_CPU:-2}
CLIENT_CPUS=${SWM_PROFILE_CLIENT_CPUS:-3-6}
CLIENT_WORKERS=${SWM_PROFILE_CLIENT_WORKERS:-4}
SKIP_PERF=${SWM_PROFILE_SKIP_PERF:-0}
EVENTS=cycles,instructions,branches,branch-misses,cache-references,cache-misses
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOAD_GENERATOR="$ROOT/scripts/profile-http-raw-load.js"

required_commands=(node taskset curl realpath)
if [[ "$SKIP_PERF" != "1" ]]; then required_commands+=(perf); fi
for command in "${required_commands[@]}"; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

mkdir -p "$OUT_DIR"
SERVER_LOG="$OUT_DIR/server.log"
METRICS_JSON="$OUT_DIR/runtime.json"
STAT_CSV="$OUT_DIR/perf-stat.csv"
LOAD_JSON="$OUT_DIR/load.json"
PERF_DATA="$OUT_DIR/perf.data"
PERF_SCRIPT="$OUT_DIR/perf.script"
SUMMARY_JSON="$OUT_DIR/summary.json"
REPORT_MD="$OUT_DIR/report.md"

server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid"
    wait "$server_pid" || true
  fi
}
trap cleanup EXIT

SWM_PROFILE_METRICS="$METRICS_JSON" \
SWM_PROFILE_PORT="$PORT" \
  taskset -c "$SERVER_CPU" node "$ROOT/scripts/profile-http-raw-server.js" \
  >"$SERVER_LOG" 2>&1 &
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
  echo "profiling server did not become ready" >&2
  exit 1
fi

taskset -c "$CLIENT_CPUS" node "$LOAD_GENERATOR" \
  --host 127.0.0.1 --port "$PORT" --connections "$CONNECTIONS" \
  --pipelining "$PIPELINING" --duration "$WARMUP" --workers "$CLIENT_WORKERS" \
  >/dev/null

curl -fsS "http://127.0.0.1:$PORT/__swm_profile_reset" >/dev/null

if [[ "$SKIP_PERF" == "1" ]]; then
  : >"$STAT_CSV"
  taskset -c "$CLIENT_CPUS" node "$LOAD_GENERATOR" \
    --host 127.0.0.1 --port "$PORT" --connections "$CONNECTIONS" \
    --pipelining "$PIPELINING" --duration "$DURATION" --workers "$CLIENT_WORKERS" \
    >"$LOAD_JSON"
else
  perf stat -x, -e "$EVENTS" -p "$server_pid" -o "$STAT_CSV" -- sleep "$DURATION" &
  stat_pid=$!
  taskset -c "$CLIENT_CPUS" node "$LOAD_GENERATOR" \
    --host 127.0.0.1 --port "$PORT" --connections "$CONNECTIONS" \
    --pipelining "$PIPELINING" --duration "$DURATION" --workers "$CLIENT_WORKERS" \
    >"$LOAD_JSON"
  wait "$stat_pid"

  if [[ -n "${FLAMEGRAPH_DIR:-}" ]]; then
    perf record -F 999 -g --call-graph dwarf -p "$server_pid" \
      -o "$PERF_DATA" -- sleep "$DURATION" &
    record_pid=$!
    taskset -c "$CLIENT_CPUS" node "$LOAD_GENERATOR" \
      --host 127.0.0.1 --port "$PORT" --connections "$CONNECTIONS" \
      --pipelining "$PIPELINING" --duration "$DURATION" --workers "$CLIENT_WORKERS" \
      >/dev/null
    wait "$record_pid"
    perf script -i "$PERF_DATA" >"$PERF_SCRIPT"
  fi
fi

kill -TERM "$server_pid"
wait "$server_pid"
server_pid=''

node --input-type=module - "$LOAD_JSON" "$STAT_CSV" "$METRICS_JSON" "$SUMMARY_JSON" "$REPORT_MD" <<'NODE'
import fs from 'node:fs'

const [loadFile, statFile, runtimeFile, summaryFile, reportFile] = process.argv.slice(2)
const load = JSON.parse(fs.readFileSync(loadFile, 'utf8'))
const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))
const requests = load.requests?.total || load.requests?.average * load.duration
const counters = {}

for (const line of fs.readFileSync(statFile, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const fields = line.split(',')
  const value = Number(fields[0])
  const event = fields[2]
  if (event && Number.isFinite(value)) counters[event] = value
}

const perRequest = Object.fromEntries(
  Object.entries(counters).map(([event, value]) => [event, value / requests])
)

const summary = {
  parameters: {
    connections: load.connections,
    pipelining: load.pipelining,
    duration: load.duration
  },
  requests,
  requestsPerSecond: load.requests?.average,
  latencyP95Ms: load.latency?.p95,
  latencyP97_5Ms: load.latency?.p97_5,
  latencyP99Ms: load.latency?.p99,
  counters,
  perRequest,
  runtime
}
const json = `${JSON.stringify(summary, null, 2)}\n`

fs.writeFileSync(summaryFile, json)
const mib = (bytes) => bytes / 1024 / 1024
const report = `# Raw HTTP response profile

| Parameter | Value |
| --- | ---: |
| Connections | ${summary.parameters.connections} |
| Pipelining | ${summary.parameters.pipelining} |
| Duration | ${summary.parameters.duration}s |

| Result | Value |
| --- | ---: |
| Throughput | ${summary.requestsPerSecond.toFixed(0)} req/s |
| p95 | ${summary.latencyP95Ms.toFixed(3)} ms |
| p97.5 | ${summary.latencyP97_5Ms.toFixed(3)} ms |
| p99 | ${summary.latencyP99Ms.toFixed(3)} ms |
| ELU | ${summary.runtime.eluPct.toFixed(2)}% |
| RSS | ${mib(summary.runtime.rssBytes).toFixed(2)} MiB |
| Heap used | ${mib(summary.runtime.heapUsedBytes).toFixed(2)} MiB |

| Native counter | Per request |
| --- | ---: |
${Object.entries(summary.perRequest)
  .map(([event, value]) => `| ${event} | ${value.toFixed(3)} |`)
  .join('\n')}
`
fs.writeFileSync(reportFile, report)
process.stdout.write(json)
NODE

if [[ "$SKIP_PERF" != "1" && -n "${FLAMEGRAPH_DIR:-}" ]]; then
  "$FLAMEGRAPH_DIR/stackcollapse-perf.pl" "$PERF_SCRIPT" \
    >"$OUT_DIR/perf.folded"
  "$FLAMEGRAPH_DIR/flamegraph.pl" "$OUT_DIR/perf.folded" \
    >"$OUT_DIR/flamegraph.svg"
fi
