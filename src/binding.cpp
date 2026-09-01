#include "binding_internal.h"
#include "prepared_header_block.h"

namespace {

void InitializeModule(v8::Local<v8::Object> exports,
                      v8::Local<v8::Value>,
                      v8::Local<v8::Context> context,
                      void *) {
    using namespace swm::binding;

    v8::Isolate *isolate = context->GetIsolate();
    uWS::Loop::get(node::GetCurrentEventLoop(isolate));

    auto *environment = new BindingEnvironment(isolate);
    v8::Local<v8::External> environmentExternal = v8::External::New(isolate, environment);

    InitializeResponseBinding(environment, environmentExternal);
    PreparedHeaderBlock::Initialize(environment, exports);
    InitializeRequestBinding(environment, environmentExternal);
    InitializeWebSocketBinding(environment, environmentExternal);
    InitializeAppBinding(environment, environmentExternal, exports);

    node::AddEnvironmentCleanupHook(
        isolate,
        [](void *argument) {
            auto *environment = static_cast<BindingEnvironment *>(argument);
            delete environment;
            uWS::Loop::get()->free();
        },
        environment);
}

} // namespace

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitializeModule)
