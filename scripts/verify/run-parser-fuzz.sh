#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fuzz_seconds="${SWM_PARSER_FUZZ_SECONDS:-15}"
parser_fuzz_cxx="${SWM_PARSER_FUZZ_CXX:-}"

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

parser_fuzz_directory="$(mktemp -d "${TMPDIR:-/tmp}/swm-uws-parser-fuzz.XXXXXX")"
trap 'rm -rf "$parser_fuzz_directory"' EXIT

"$parser_fuzz_cxx" \
  -std=c++20 \
  -O1 \
  -g \
  -fno-omit-frame-pointer \
  -fsanitize=fuzzer,address,undefined \
  -I"$repository_root/vendor/uWebSockets/src" \
  -I"$repository_root/vendor/uSockets/src" \
  "$repository_root/test/fuzz/parser-fuzz.cpp" \
  -o "$parser_fuzz_directory/parser-fuzz"

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
  "$parser_fuzz_directory/parser-fuzz" \
    -dict="$repository_root/test/fuzz/parser.dict" \
    -max_total_time="$fuzz_seconds" \
    -max_len=65536 \
    -rss_limit_mb=2048 \
    -timeout=2
