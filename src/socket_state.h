#ifndef SWM_UWS_SOCKET_STATE_H
#define SWM_UWS_SOCKET_STATE_H

#include <App.h>
#include <v8.h>

namespace swm::binding {

class SocketState;

struct PerSocketData {
    SocketState *state = nullptr;
};

using NativeWebSocket = uWS::WebSocket<false, true, PerSocketData>;

class SocketState final {
public:
    explicit SocketState(v8::Isolate *isolate) noexcept : isolate_(isolate) {}

    SocketState(const SocketState &) = delete;
    SocketState &operator=(const SocketState &) = delete;

    [[nodiscard]] v8::Isolate *Isolate() const noexcept {
        return isolate_;
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
    NativeWebSocket *socket_ = nullptr;
    bool callbackFailed_ = false;
    v8::Global<v8::Object> object_;
    v8::Global<v8::Value> userData_;
};

} // namespace swm::binding

#endif // SWM_UWS_SOCKET_STATE_H
