#include "socket_state.h"

#include <utility>

namespace swm::binding {

void SocketState::LeaveNativeCallback() noexcept {
    if (!nativeCallbackDepth_) return;
    nativeCallbackDepth_--;
    if (nativeCallbackDepth_ || pendingAction_ == PendingAction::None) return;

    const PendingAction action = pendingAction_;
    NativeWebSocket *socket = pendingSocket_;
    const int code = pendingEndCode_;
    std::string reason = std::move(pendingEndReason_);
    pendingAction_ = PendingAction::None;
    pendingSocket_ = nullptr;
    pendingEndCode_ = 0;

    // The native close callback can destroy this SocketState. Do not access
    // members after dispatching the pending terminal action.
    if (action == PendingAction::Close) {
        socket->close();
    } else {
        socket->end(code, reason);
    }
}

void SocketState::RequestClose(NativeWebSocket *socket) noexcept {
    if (!socket) return;
    if (nativeCallbackDepth_) {
        pendingAction_ = PendingAction::Close;
        pendingSocket_ = socket;
        pendingEndCode_ = 0;
        pendingEndReason_.clear();
        return;
    }
    socket->close();
}

void SocketState::RequestEnd(NativeWebSocket *socket, int code, std::string reason) noexcept {
    if (!socket) return;
    if (nativeCallbackDepth_) {
        pendingAction_ = PendingAction::End;
        pendingSocket_ = socket;
        pendingEndCode_ = code;
        pendingEndReason_ = std::move(reason);
        return;
    }
    socket->end(code, reason);
}

} // namespace swm::binding
