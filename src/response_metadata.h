#ifndef SWM_UWS_RESPONSE_METADATA_H
#define SWM_UWS_RESPONSE_METADATA_H

#include <cstdint>
#include <memory>
#include <optional>

namespace swm::binding {

class AppState;
class ResponseCallbackLifetime;
class UpgradeContext;

struct ResponseMetadata {
    explicit ResponseMetadata(AppState *app = nullptr,
                              ResponseCallbackLifetime *callbackLifetime = nullptr) noexcept
        : app(app), callbackLifetime(callbackLifetime) {}

    AppState *app = nullptr;
    ResponseCallbackLifetime *callbackLifetime = nullptr;
    std::shared_ptr<UpgradeContext> upgradeContext;
    std::optional<uintmax_t> tryEndTotal;
    bool chunked = false;
};

} // namespace swm::binding

#endif // SWM_UWS_RESPONSE_METADATA_H
