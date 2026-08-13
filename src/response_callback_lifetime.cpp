#include "response_callback_lifetime.h"

#include "app_state.h"

namespace swm::binding {

ResponseCallbackLifetime::ResponseCallbackLifetime(AppState *app) noexcept : app_(app) {}

bool ResponseCallbackLifetime::IsActive() const noexcept {
    return active_ && app_ && !app_->IsClosed();
}

void ResponseCallbackLifetime::Invalidate() noexcept {
    active_ = false;
}

} // namespace swm::binding
