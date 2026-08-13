#ifndef SWM_UWS_UPGRADE_CONTEXT_H
#define SWM_UWS_UPGRADE_CONTEXT_H

#include <App.h>
#include <v8.h>

namespace swm::binding {

using HttpResponse = uWS::HttpResponse<false>;

class UpgradeContext final {
public:
    UpgradeContext(v8::Isolate *isolate,
                   HttpResponse *response,
                   us_socket_context_t *nativeContext);

    UpgradeContext(const UpgradeContext &) = delete;
    UpgradeContext &operator=(const UpgradeContext &) = delete;

    [[nodiscard]] v8::Local<v8::External> Token() const;
    [[nodiscard]] bool Matches(v8::Local<v8::Value> token, HttpResponse *response) const;
    [[nodiscard]] us_socket_context_t *NativeContext() const noexcept;

private:
    v8::Isolate *isolate_;
    HttpResponse *response_;
    us_socket_context_t *nativeContext_;
    v8::Global<v8::External> token_;
};

} // namespace swm::binding

#endif // SWM_UWS_UPGRADE_CONTEXT_H
