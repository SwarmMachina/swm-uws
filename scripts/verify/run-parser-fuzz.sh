#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fuzz_seconds="${SWM_PARSER_FUZZ_SECONDS:-15}"
parser_fuzz_cxx="${SWM_PARSER_FUZZ_CXX:-}"
parser_fuzz_cxx_explicit=0

if [[ -n "$parser_fuzz_cxx" ]]; then
  parser_fuzz_cxx_explicit=1
fi

if ! [[ "$fuzz_seconds" =~ ^[1-9][0-9]*$ ]] || ((fuzz_seconds > 86400)); then
  echo "SWM_PARSER_FUZZ_SECONDS must be an integer between 1 and 86400" >&2
  exit 1
fi

if [[ -z "$parser_fuzz_cxx" ]]; then
  for candidate in clang++-18 /opt/homebrew/opt/llvm@18/bin/clang++ clang++; do
    if command -v "$candidate" >/dev/null 2>&1; then
      parser_fuzz_cxx="$candidate"
      break
    fi
  done
fi

if [[ -z "$parser_fuzz_cxx" ]]; then
  echo "clang++ with libFuzzer support is required" >&2
  exit 1
fi

sanitizer_flags=(-fsanitize=fuzzer,address,undefined)
linker_inputs=()
asan_detect_leaks=1

# Homebrew LLVM 18's ASan runtime deadlocks during dyld initialization on
# current macOS releases. Prefer the OS-matched Apple ASan/UBSan runtime while
# retaining Homebrew's static libFuzzer runtime when Xcode does not ship one.
if [[ "$(uname -s)" == "Darwin" ]]; then
  asan_detect_leaks=0

  if ((parser_fuzz_cxx_explicit == 0)) && [[ -x /usr/bin/clang++ ]]; then
    selected_resource_directory="$("$parser_fuzz_cxx" --print-resource-dir)"
    system_resource_directory="$(/usr/bin/clang++ --print-resource-dir)"
    system_fuzzer_runtime="$system_resource_directory/lib/darwin/libclang_rt.fuzzer_osx.a"
    selected_fuzzer_runtime="$selected_resource_directory/lib/darwin/libclang_rt.fuzzer_osx.a"

    if [[ -f "$system_fuzzer_runtime" ]]; then
      parser_fuzz_cxx=/usr/bin/clang++
    elif [[ -f "$selected_fuzzer_runtime" ]]; then
      parser_fuzz_cxx=/usr/bin/clang++
      sanitizer_flags=(-fsanitize=fuzzer-no-link,address,undefined)
      linker_inputs+=("$selected_fuzzer_runtime")
    fi
  fi
fi

parser_fuzz_directory="$(mktemp -d "${TMPDIR:-/tmp}/swm-uws-parser-fuzz.XXXXXX")"
fuzz_pid=""
watchdog_pid=""

cleanup() {
  if [[ -n "$watchdog_pid" ]]; then
    kill -TERM "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n "$fuzz_pid" ]]; then
    kill -TERM "$fuzz_pid" 2>/dev/null || true
  fi
  rm -rf "$parser_fuzz_directory"
}

trap cleanup EXIT

"$parser_fuzz_cxx" \
  -std=c++20 \
  -O1 \
  -g \
  -fno-omit-frame-pointer \
  "${sanitizer_flags[@]}" \
  -I"$repository_root/vendor/uWebSockets/src" \
  -I"$repository_root/vendor/uSockets/src" \
  "$repository_root/test/fuzz/parser-fuzz.cpp" \
  "${linker_inputs[@]}" \
  -o "$parser_fuzz_directory/parser-fuzz"

set +e
ASAN_OPTIONS="detect_leaks=$asan_detect_leaks:halt_on_error=1" \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
  "$parser_fuzz_directory/parser-fuzz" \
    -dict="$repository_root/test/fuzz/parser.dict" \
    -max_total_time="$fuzz_seconds" \
    -max_len=65536 \
    -rss_limit_mb=2048 \
    -timeout=2 &
fuzz_pid=$!

(
  sleep "$((fuzz_seconds + 15))"
  if kill -0 "$fuzz_pid" 2>/dev/null; then
    echo "parser fuzz exceeded its $fuzz_seconds second budget plus 15 second grace" >&2
    kill -TERM "$fuzz_pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$fuzz_pid" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

wait "$fuzz_pid"
fuzz_status=$?
fuzz_pid=""
kill -TERM "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null
watchdog_pid=""
set -e

exit "$fuzz_status"
