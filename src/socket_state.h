#ifndef SWM_UWS_SOCKET_STATE_H
#define SWM_UWS_SOCKET_STATE_H

#include <App.h>
#include <v8.h>

#include <cstddef>
#include <memory>

namespace swm::binding {

class AppState;
class SocketState;

struct PerSocketData {
    std::shared_ptr<SocketState> state;
};

using NativeWebSocket = uWS::WebSocket<false, true, PerSocketData>;

class SocketState final {
public:
    SocketState(v8::Isolate *isolate, AppState &app) noexcept : isolate_(isolate), app_(app) {}

    SocketState(const SocketState &) = delete;
    SocketState &operator=(const SocketState &) = delete;

    [[nodiscard]] v8::Isolate *Isolate() const noexcept {
        return isolate_;
    }

    [[nodiscard]] AppState &App() const noexcept {
        return app_;
    }

    [[nodiscard]] NativeWebSocket *Socket() const noexcept {
        return socket_;
    }

    void AttachSocket(NativeWebSocket *socket) noexcept {
        socket_ = socket;
    }

    [[nodiscard]] NativeWebSocket *DetachSocket() noexcept {
        NativeWebSocket *socket = socket_;
        socket_ = nullptr;
        return socket;
    }

    void EnterNativeCallback() noexcept {
        nativeCallbackDepth_++;
    }

    void LeaveNativeCallback() noexcept {
        if (!nativeCallbackDepth_) return;
        nativeCallbackDepth_--;
        if (nativeCallbackDepth_ || !pendingClose_) return;
        NativeWebSocket *socket = pendingClose_;
        pendingClose_ = nullptr;
        socket->close();
    }

    void RequestClose(NativeWebSocket *socket) noexcept {
        if (!socket) return;
        if (nativeCallbackDepth_) {
            pendingClose_ = socket;
            return;
        }
        socket->close();
    }

    [[nodiscard]] bool CallbackFailed() const noexcept {
        return callbackFailed_;
    }

    void MarkCallbackFailed() noexcept {
        callbackFailed_ = true;
    }

    [[nodiscard]] bool HasObject() const noexcept {
        return !object_.IsEmpty();
    }

    [[nodiscard]] v8::Local<v8::Object> Object() const {
        return object_.Get(isolate_);
    }

    void SetObject(v8::Local<v8::Object> object) {
        object_.Reset(isolate_, object);
    }

    void ResetObject() {
        object_.Reset();
    }

    [[nodiscard]] bool HasUserData() const noexcept {
        return !userData_.IsEmpty();
    }

    [[nodiscard]] v8::Local<v8::Value> UserData() const {
        return userData_.Get(isolate_);
    }

    void SetUserData(v8::Local<v8::Value> userData) {
        userData_.Reset(isolate_, userData);
    }

    void ResetUserData() {
        userData_.Reset();
    }

private:
    v8::Isolate *isolate_;
    AppState &app_;
    NativeWebSocket *socket_ = nullptr;
    NativeWebSocket *pendingClose_ = nullptr;
    std::size_t nativeCallbackDepth_ = 0;
    bool callbackFailed_ = false;
    v8::Global<v8::Object> object_;
    v8::Global<v8::Value> userData_;
};

} // namespace swm::binding

#endif // SWM_UWS_SOCKET_STATE_H
