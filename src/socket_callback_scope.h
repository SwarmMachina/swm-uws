#ifndef SWM_UWS_SOCKET_CALLBACK_SCOPE_H
#define SWM_UWS_SOCKET_CALLBACK_SCOPE_H

namespace swm::binding {

class AppState;
class SocketState;

class SocketCallbackScope final {
public:
    explicit SocketCallbackScope(SocketState &socket) noexcept;
    ~SocketCallbackScope();

    SocketCallbackScope(const SocketCallbackScope &) = delete;
    SocketCallbackScope &operator=(const SocketCallbackScope &) = delete;

private:
    AppState &app_;
    SocketState &socket_;
};

} // namespace swm::binding

#endif // SWM_UWS_SOCKET_CALLBACK_SCOPE_H
