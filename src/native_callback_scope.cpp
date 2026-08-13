#include "native_callback_scope.h"

#include "app_state.h"
#include "async_response_state.h"
#include "socket_state.h"

namespace swm::binding {

NativeCallbackScope::NativeCallbackScope(
    AppState &app, const std::shared_ptr<AsyncResponseState> &response) noexcept
    : app_(app), response_(response) {
    app_.EnterNativeCallback();
    response_->EnterNativeCallback();
}

NativeCallbackScope::NativeCallbackScope(AppState &app,
                                         const std::shared_ptr<SocketState> &socket) noexcept
    : app_(app), socket_(socket) {
    app_.EnterNativeCallback();
    socket_->EnterNativeCallback();
}

NativeCallbackScope::~NativeCallbackScope() {
    if (response_) response_->LeaveNativeCallback();
    if (socket_) socket_->LeaveNativeCallback();
    app_.LeaveNativeCallback();
}

} // namespace swm::binding
