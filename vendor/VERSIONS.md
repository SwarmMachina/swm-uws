# Vendored upstream revisions

The files under `vendor/` are copied sources, not git submodules.

| Component                    | Upstream                                      | Revision                                                |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| uWebSockets.js release tag   | https://github.com/uNetworking/uWebSockets.js | `v20.71.0` / `9ec36de7709996c58dce03d63796216c90a17136` |
| uWebSockets.js source commit | https://github.com/uNetworking/uWebSockets.js | `127ac8029b04e8272da068055bc04c1cd0d7bd38`              |
| uWebSockets                  | https://github.com/uNetworking/uWebSockets    | `1d80f7a53816ef2433e89793b285b827f3efb2b2`              |
| uSockets                     | https://github.com/uNetworking/uSockets       | `86097c490263ab662d62e8e7b541390bdec7d149`              |

The release tag contains prebuilt binaries. Its `source_commit` file points to
the uWebSockets.js source commit above, whose gitlinks pin the uWebSockets and
uSockets revisions copied here.

Local deviations are documented in [PATCHES.md](./PATCHES.md) and reapplied by
the vendor updater.
