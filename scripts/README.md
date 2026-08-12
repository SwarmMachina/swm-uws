# Internal tooling

- Repository `benchmark/` contains benchmark code, profiles, and captured reports.
- `benchmark/pgo/build-native-pgo.sh` builds a PGO binary and drives its training paths.
- `release/` assembles, validates, and tests release artifacts.
- `test/` runs the repository test suite without recursively treating fixtures as tests.
- `vendor/` refreshes and verifies the checked-in upstream source snapshot.
- `verify/` contains static native checks, upstream-surface validation, and parser fuzzing.

The public entrypoints are the named commands in `package.json`; CI invokes those
commands when possible. Files in these directories are internal implementation details.
