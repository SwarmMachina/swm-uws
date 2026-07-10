# Vendored upstream revisions

The files under `vendor/` are copied sources, not git submodules.

| Component | Upstream | Revision |
| --- | --- | --- |
| uWebSockets.js release tag | https://github.com/uNetworking/uWebSockets.js | `v20.67.0` / `e0f56ebb4b349017f006e14d1cd29052f2a7121d` |
| uWebSockets.js source commit | https://github.com/uNetworking/uWebSockets.js | `29a1a0b15b0402a7a6adef9a5f585412ec7785c2` |
| uWebSockets | https://github.com/uNetworking/uWebSockets | `8dd7fcbc4339e6c8ce26732ef6237ebaf4504e9a` |
| uSockets | https://github.com/uNetworking/uSockets | `86097c490263ab662d62e8e7b541390bdec7d149` |

The release tag contains prebuilt binaries. Its `source_commit` file points to
the uWebSockets.js source commit above, whose gitlinks pin the uWebSockets and
uSockets revisions copied here.
