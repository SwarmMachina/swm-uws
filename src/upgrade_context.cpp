#include "upgrade_context.h"

namespace swm::binding {

UpgradeContext::UpgradeContext(v8::Isolate *isolate,
                               HttpResponse *response,
                               us_socket_context_t *nativeContext)
    : isolate_(isolate), response_(response), nativeContext_(nativeContext),
      token_(isolate, v8::External::New(isolate, nativeContext)) {}

v8::Local<v8::External> UpgradeContext::Token() const {
    return token_.Get(isolate_);
}

bool UpgradeContext::Matches(v8::Local<v8::Value> token, HttpResponse *response) const {
    return response == response_ && token->IsExternal() && Token()->StrictEquals(token);
}

us_socket_context_t *UpgradeContext::NativeContext() const noexcept {
    return nativeContext_;
}

} // namespace swm::binding
