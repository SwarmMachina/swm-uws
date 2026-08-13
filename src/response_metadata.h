#ifndef SWM_UWS_RESPONSE_METADATA_H
#define SWM_UWS_RESPONSE_METADATA_H

#include <cstdint>
#include <optional>

namespace swm::binding {

class AppState;
class ResponseCallbackLifetime;

struct ResponseMetadata {
    explicit ResponseMetadata(AppState *app = nullptr,
                              ResponseCallbackLifetime *callbackLifetime = nullptr) noexcept
        : app(app), callbackLifetime(callbackLifetime) {}

    AppState *app = nullptr;
    ResponseCallbackLifetime *callbackLifetime = nullptr;
    std::optional<uintmax_t> tryEndTotal;
    bool chunked = false;
};

} // namespace swm::binding

#endif // SWM_UWS_RESPONSE_METADATA_H
