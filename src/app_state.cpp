#include "app_state.h"

#include "binding_environment.h"
#include "listen_socket_handle.h"

#include <algorithm>

namespace swm::binding {

AppState::AppState(BindingEnvironment &environment, std::unique_ptr<uWS::App> app) noexcept
    : environment_(environment), app_(std::move(app)) {}

AppState::~AppState() {
    Close();
    if (nativeClosePending_ && app_) {
        nativeClosePending_ = false;
        app_->close();
    }
}

void AppState::AttachObject(v8::Local<v8::Object> object) {
    object_.Reset(environment_.Isolate(), object);
    object_.SetWeak(
        this,
        [](const v8::WeakCallbackInfo<AppState> &info) {
            AppState *state = info.GetParameter();
            state->object_.Reset();
            if (!state->app_) state->environment_.ReleaseApp(state);
        },
        v8::WeakCallbackType::kParameter);
}

uWS::HttpTransportStats AppState::TransportStats() const noexcept {
    return app_ ? app_->getHttpTransportStats() : finalStats_;
}

void AppState::DisposeNativeApp() {
    finalStats_ = app_->getHttpTransportStats();
    app_.reset();
    if (object_.IsEmpty()) environment_.ReleaseApp(this);
}

ListenSocketHandle *AppState::TrackListenSocket(us_listen_socket_t *socket) {
    if (!socket) return nullptr;
    auto handle = std::make_unique<ListenSocketHandle>(environment_.Isolate(), socket);
    ListenSocketHandle *ownedHandle = handle.get();
    listenSockets_.push_back(std::move(handle));
    return ownedHandle;
}

bool AppState::CloseListenSocket(v8::Local<v8::Value> token) {
    const auto iterator =
        std::find_if(listenSockets_.begin(), listenSockets_.end(), [token](const auto &handle) {
            return handle->Matches(token);
        });
    if (iterator == listenSockets_.end()) return false;
    (*iterator)->Close();
    listenSockets_.erase(iterator);
    return true;
}

bool AppState::CloseListenSocket(ListenSocketHandle *handle) {
    const auto iterator =
        std::find_if(listenSockets_.begin(), listenSockets_.end(), [handle](const auto &owned) {
            return owned.get() == handle;
        });
    if (iterator == listenSockets_.end()) return false;
    (*iterator)->Close();
    listenSockets_.erase(iterator);
    return true;
}

std::optional<int> AppState::ListenSocketLocalPort(v8::Local<v8::Value> token) const {
    const auto iterator =
        std::find_if(listenSockets_.begin(), listenSockets_.end(), [token](const auto &handle) {
            return handle->Matches(token);
        });
    if (iterator == listenSockets_.end()) return std::nullopt;
    return (*iterator)->LocalPort();
}

void AppState::Close() noexcept {
    if (closed_) return;
    closed_ = true;
    if (!environment_.IsClosing()) {
        // Router, parser and pub/sub frames can still hold native context pointers.
        // The environment owns this state until disposal and wrapper collection.
        uWS::Loop::get()->defer([this]() { DisposeNativeApp(); });
    }
    for (const auto &socket : listenSockets_) {
        socket->Close();
    }
    listenSockets_.clear();
    if (nativeCallbackDepth_) {
        nativeClosePending_ = true;
        return;
    }
    if (app_) app_->close();
}

void AppState::LeaveNativeCallback() noexcept {
    if (!nativeCallbackDepth_) return;
    nativeCallbackDepth_--;
    if (nativeCallbackDepth_ || !nativeClosePending_) return;
    nativeClosePending_ = false;
    if (app_) app_->close();
}

} // namespace swm::binding
