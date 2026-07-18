{
  "variables": {
    "swm_uws_version%": "<!(node -p \"require('./package.json').version\")",
    "swm_uws_upstream_version%": "<!(node -p \"require('./package.json').upstream.uWebSocketsJs\")"
  },
  "targets": [
    {
      "target_name": "swm_uws",
      "sources": [
        "src/binding.cpp",
        "vendor/uSockets/src/bsd.c",
        "vendor/uSockets/src/context.c",
        "vendor/uSockets/src/loop.c",
        "vendor/uSockets/src/socket.c",
        "vendor/uSockets/src/udp.c",
        "vendor/uSockets/src/eventing/libuv.c"
      ],
      "include_dirs": [
        "vendor/uWebSockets/src",
        "vendor/uSockets/src"
      ],
      "defines": [
        "LIBUS_USE_LIBUV=1",
        "LIBUS_NO_SSL=1",
        "UWS_WITH_PROXY=1",
        "UWS_NO_ZLIB=1",
        "SWM_UWS_VERSION=\"<(swm_uws_version)\"",
        "SWM_UWS_UPSTREAM_VERSION=\"<(swm_uws_upstream_version)\""
      ],
      "cflags_cc": [
        "-std=c++20",
        "-fno-exceptions"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
      },
      "conditions": [
        [
          "OS=='linux'",
          {
            "cflags": [
              "-flto"
            ],
            "cflags_cc": [
              "-flto"
            ],
            "ldflags": [
              "-flto",
              "-O3",
              "-static-libstdc++",
              "-static-libgcc",
              "-s"
            ]
          }
        ],
        [
          "OS=='win'",
          {
            "defines": [
              "WIN32_LEAN_AND_MEAN",
              "NOMINMAX"
            ],
            "libraries": [
              "Ws2_32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++20"
                ],
                "ExceptionHandling": 0
              }
            }
          }
        ]
      ]
    }
  ]
}
