#ifndef SWM_UWS_NATIVE_CALLBACK_SCOPE_H
#define SWM_UWS_NATIVE_CALLBACK_SCOPE_H

#include <memory>

namespace swm::binding {

class AppState;
class AsyncResponseState;
class SocketState;

class NativeCallbackScope final {
public:
    NativeCallbackScope(AppState &app,
                        const std::shared_ptr<AsyncResponseState> &response) noexcept;
    NativeCallbackScope(AppState &app, const std::shared_ptr<SocketState> &socket) noexcept;
    ~NativeCallbackScope();

    NativeCallbackScope(const NativeCallbackScope &) = delete;
    NativeCallbackScope &operator=(const NativeCallbackScope &) = delete;

private:
    AppState &app_;
    std::shared_ptr<AsyncResponseState> response_;
    std::shared_ptr<SocketState> socket_;
};

} // namespace swm::binding

#endif // SWM_UWS_NATIVE_CALLBACK_SCOPE_H
