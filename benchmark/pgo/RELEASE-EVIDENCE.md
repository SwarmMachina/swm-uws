# PGO release evidence

Linux CI builds three independent instrument/train/optimize candidates per ABI
(Node 22 and 24). PGO_BUILD_ID invalidates the training layer for each build;
the dependency/toolchain layer is shared. Every candidate runs the full HTTP,
feature and WS comparison suite against the pinned upstream. All must pass.
Build 1 is selected in advance for packaging, never the fastest observed build.
Source file manifests and completed training counts must agree across builds.
The regression job writes `qualification.json` after all three scheduled builds,
including integrity, candidate identity, HTTP/feature/WS status and cross-build
source/training consistency. A failed build remains in that aggregate evidence.

Training defaults: 1,000,000 GET, 250,000 POST, and 500,000 WS echoes at each
of depths 1 and 16, with 100 connections. HTTP uses one outstanding request
per connection. Override counts with SWM_PGO_GET_COUNT, SWM_PGO_POST_COUNT,
and SWM_PGO_WS_COUNT. The five-minute client timeout is a failure deadline,
not a workload duration. Functional test profiles are retained under validation/ but excluded from the
optimizer input. Only the fixed-work server profile is merged. Readiness uses
the reported ephemeral port and one GET. Scheduling and LLVM counters are not
promised to be byte-identical.

The build retains raw profiles, merged swm.profdata, workload counts, runtime
metrics, compiler/Node versions, source hashes, final candidate and SHA256SUMS.
SWM_PGO_EVIDENCE_DIR must be empty. Docker exports evidence beside the prebuild;
The local prebuild builder retains complete exports under pgo-evidence/node-*
and copies only the ABI binaries into prebuilds/. CI retains independent-builds
artifacts for 90 days. Failed Docker RUN layers
cannot export partial evidence; local builds retain it at the evidence path.

WS uses six alternating ABBA/BAAB blocks, twelve load workers, 100 connections,
256-byte messages, client CPUs 1,3-13 (SWM_BENCH_WS_CLIENT_CPUS), server CPU 2,
two seconds warmup and five seconds measurement. Both depths
must remain within the existing 5% throughput budget. Errors, drops, backpressure, missing throughput/telemetry
and >=95% worker/parent ELU invalidate the series. Raw load rows are checkpointed
before validation. This is an upstream parity gate, not proof of parity with a
previous published swm artifact or of byte-reproducible binaries.

Do not release 0.8.3 until these Linux CI jobs have actually passed. A local macOS
training test or lint pass does not satisfy the independent-build release gate.

The four-worker WS protocol was invalidated on Linux by generator saturation
(95.62% worker ELU). Its rows remain diagnostic evidence. The gate requires
twelve workers and does not accept or pool the earlier four/eight-worker results.

The eight-worker calibration passed depth 1 but saturated all workers at depth
16 (798.5% process CPU, 100% worker ELU; target ELU 97.47%). The twelve-worker
protocol uses twelve physical client cores, excluding CPU 0 and target CPU 2.

WS uses a fixed Node 24 driver for both ABIs. SWM_BENCH_WS_DRIVER_NODE selects
the driver executable; the suite preserves its current Node executable as
SWM_BENCH_WS_TARGET_NODE. The target ABI and version are queried independently.
Node 22 driver calibration saturated at depth 16 even with twelve workers;
those rows are retained but excluded from the Node 24 driver qualification.
