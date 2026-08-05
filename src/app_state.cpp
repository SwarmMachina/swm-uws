#include "app_state.h"

#include "binding_environment.h"

#include <algorithm>

namespace swm::binding {

AppState::AppState(BindingEnvironment &environment, std::unique_ptr<uWS::App> app) noexcept
    : environment_(environment), app_(std::move(app)) {}

AppState::~AppState() {
    Close();
}

v8::Global<v8::Function> *AppState::OwnHandler(v8::Isolate *isolate,
                                               v8::Local<v8::Function> handler) {
    return OwnHandler(std::make_unique<v8::Global<v8::Function>>(isolate, handler));
}

v8::Global<v8::Function> *AppState::OwnHandler(std::unique_ptr<v8::Global<v8::Function>> handler) {
    v8::Global<v8::Function> *ownedHandler = handler.get();
    handlers_.push_back(std::move(handler));
    return ownedHandler;
}

void AppState::TrackListenSocket(us_listen_socket_t *socket) {
    if (socket) listenSockets_.push_back(socket);
}

void AppState::ForgetListenSocket(us_listen_socket_t *socket) {
    listenSockets_.erase(std::remove(listenSockets_.begin(), listenSockets_.end(), socket),
                         listenSockets_.end());
}

void AppState::CloseListenSocket(us_listen_socket_t *socket) {
    ForgetListenSocket(socket);
    us_listen_socket_close(0, socket);
}

void AppState::Close() noexcept {
    if (closed_) return;
    closed_ = true;
    for (us_listen_socket_t *socket : listenSockets_) {
        us_listen_socket_close(0, socket);
    }
    listenSockets_.clear();
    if (app_) app_->close();
}

} // namespace swm::binding
