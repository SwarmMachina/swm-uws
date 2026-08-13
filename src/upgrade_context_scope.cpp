#include "upgrade_context_scope.h"

#include "binding_environment.h"

namespace swm::binding {

UpgradeContextScope::UpgradeContextScope(BindingEnvironment &environment,
                                         HttpResponse *response,
                                         us_socket_context_t *context)
    : environment_(environment), response_(response), context_(context),
      token_(environment.Isolate(), v8::External::New(environment.Isolate(), context)) {
    environment_.RegisterUpgradeContext(this);
}

UpgradeContextScope::~UpgradeContextScope() {
    environment_.UnregisterUpgradeContext(this);
}

v8::Local<v8::External> UpgradeContextScope::Token() const {
    return token_.Get(environment_.Isolate());
}

bool UpgradeContextScope::Matches(v8::Local<v8::Value> token, HttpResponse *response) const {
    return response == response_ && token->IsExternal() && Token()->StrictEquals(token);
}

us_socket_context_t *UpgradeContextScope::NativeContext() const noexcept {
    return context_;
}

} // namespace swm::binding
