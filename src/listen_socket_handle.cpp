#include "listen_socket_handle.h"

#include <utility>

namespace swm::binding {

ListenSocketHandle::ListenSocketHandle(v8::Isolate *isolate, us_listen_socket_t *socket)
    : isolate_(isolate), socket_(socket), token_(isolate, v8::External::New(isolate, socket)) {}

ListenSocketHandle::~ListenSocketHandle() {
    Close();
}

v8::Local<v8::External> ListenSocketHandle::Token() const {
    return token_.Get(isolate_);
}

bool ListenSocketHandle::Matches(v8::Local<v8::Value> token) const {
    return token->IsExternal() && Token()->StrictEquals(token);
}

int ListenSocketHandle::LocalPort() const noexcept {
    return socket_ ? us_socket_local_port(0, reinterpret_cast<us_socket_t *>(socket_)) : -1;
}

void ListenSocketHandle::Close() noexcept {
    us_listen_socket_t *socket = std::exchange(socket_, nullptr);
    if (socket) us_listen_socket_close(0, socket);
}

} // namespace swm::binding
