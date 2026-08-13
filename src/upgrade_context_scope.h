#ifndef SWM_UWS_UPGRADE_CONTEXT_SCOPE_H
#define SWM_UWS_UPGRADE_CONTEXT_SCOPE_H

#include <App.h>
#include <v8.h>

namespace swm::binding {

class BindingEnvironment;
using HttpResponse = uWS::HttpResponse<false>;

class UpgradeContextScope final {
public:
    UpgradeContextScope(BindingEnvironment &environment,
                        HttpResponse *response,
                        us_socket_context_t *context);
    ~UpgradeContextScope();

    UpgradeContextScope(const UpgradeContextScope &) = delete;
    UpgradeContextScope &operator=(const UpgradeContextScope &) = delete;

    [[nodiscard]] v8::Local<v8::External> Token() const;
    [[nodiscard]] bool Matches(v8::Local<v8::Value> token, HttpResponse *response) const;
    [[nodiscard]] us_socket_context_t *NativeContext() const noexcept;

private:
    BindingEnvironment &environment_;
    HttpResponse *response_;
    us_socket_context_t *context_;
    v8::Global<v8::External> token_;
};

} // namespace swm::binding

#endif // SWM_UWS_UPGRADE_CONTEXT_SCOPE_H
