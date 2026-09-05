#include <node.h>
#include <uv.h>
#include <libusockets.h>
#include <cstdlib>
#include <unordered_set>
#include "allocator.h"

namespace {
std::unordered_set<void *> allocations;
}

extern "C" void *swm_test_malloc(size_t size) {
    void *pointer = std::malloc(size);
    if (pointer) allocations.insert(pointer);
    return pointer;
}
extern "C" void *swm_test_calloc(size_t count, size_t size) {
    void *pointer = std::calloc(count, size);
    if (pointer) allocations.insert(pointer);
    return pointer;
}
extern "C" void *swm_test_realloc(void *pointer, size_t size) {
    allocations.erase(pointer);
    void *result = std::realloc(pointer, size);
    if (result) allocations.insert(result);
    else if (size && pointer) allocations.insert(pointer);
    return result;
}
extern "C" void swm_test_free(void *pointer) {
    allocations.erase(pointer);
    std::free(pointer);
}

namespace {
void Run(const v8::FunctionCallbackInfo<v8::Value> &args) {
    uv_loop_t nativeLoop;
    if (uv_loop_init(&nativeLoop)) std::abort();
    auto callback = [](us_loop_t *) {};
    auto *loop = us_create_loop(&nativeLoop, callback, callback, callback, 0);
    auto *context = us_create_socket_context(0, loop, 0, {});
    for (int index = 0; index < 16; index++) {
        if (!us_socket_context_listen(0, context, "127.0.0.1", 0, 0, 0)) std::abort();
    }
    // Match Node environment teardown: close resources, then free the borrowed
    // loop without another uSockets post iteration. libuv drains close callbacks.
    us_socket_context_close(0, context);
    us_socket_context_free(0, context);
    us_loop_free(loop);
    uv_run(&nativeLoop, UV_RUN_DEFAULT);
    if (uv_loop_close(&nativeLoop)) std::abort();
    args.GetReturnValue().Set(static_cast<unsigned int>(allocations.size()));
}
void Initialize(v8::Local<v8::Object> exports) {
    NODE_SET_METHOD(exports, "run", Run);
}
NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}
