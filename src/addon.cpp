#include <napi.h>

#include "app.h"

namespace {

Napi::Value Version(const Napi::CallbackInfo &info) {
    return Napi::String::New(info.Env(), "0.1.0+uWebSockets-v20.67.0");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("version", Napi::Function::New(env, Version, "version"));
    InitApp(env, exports);
    return exports;
}

}  // namespace

NODE_API_MODULE(swm_uws, Init)
