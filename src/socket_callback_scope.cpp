#include "socket_callback_scope.h"

#include "app_state.h"
#include "socket_state.h"

namespace swm::binding {

SocketCallbackScope::SocketCallbackScope(SocketState &socket) noexcept
    : app_(socket.App()), socket_(socket) {
    app_.EnterNativeCallback();
    socket_.EnterNativeCallback();
}

SocketCallbackScope::~SocketCallbackScope() {
    socket_.LeaveNativeCallback();
    app_.LeaveNativeCallback();
}

} // namespace swm::binding
