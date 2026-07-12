# Vendored upstream revisions

The files under `vendor/` are copied sources, not git submodules.

| Component | Upstream | Revision |
| --- | --- | --- |
| uWebSockets.js release tag | https://github.com/uNetworking/uWebSockets.js | `v20.69.0` / `dddd8ffd1b2c28a66022160923ca92f064cdacb4` |
| uWebSockets.js source commit | https://github.com/uNetworking/uWebSockets.js | `faf115275bb9c55edf739a06406849e42e89ec04` |
| uWebSockets | https://github.com/uNetworking/uWebSockets | `fe7c01a477b688a7743f754fee33bdd78d52ad91` |
| uSockets | https://github.com/uNetworking/uSockets | `86097c490263ab662d62e8e7b541390bdec7d149` |

The release tag contains prebuilt binaries. Its `source_commit` file points to
the uWebSockets.js source commit above, whose gitlinks pin the uWebSockets and
uSockets revisions copied here.

Local deviations are documented in [PATCHES.md](./PATCHES.md) and reapplied by
the vendor updater.
