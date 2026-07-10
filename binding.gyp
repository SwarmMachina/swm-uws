{
  "targets": [
    {
      "target_name": "swm_uws",
      "sources": [
        "src/addon.cpp",
        "src/app.cpp",
        "vendor/uSockets/src/bsd.c",
        "vendor/uSockets/src/context.c",
        "vendor/uSockets/src/loop.c",
        "vendor/uSockets/src/socket.c",
        "vendor/uSockets/src/udp.c",
        "vendor/uSockets/src/eventing/libuv.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/uWebSockets/src",
        "vendor/uSockets/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LIBUS_USE_LIBUV=1",
        "LIBUS_NO_SSL=1",
        "UWS_NO_ZLIB=1"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fno-exceptions"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO"
      },
      "conditions": [
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
                  "/std:c++17"
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
