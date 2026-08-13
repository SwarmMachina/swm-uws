#ifndef SWM_UWS_LISTEN_SOCKET_HANDLE_H
#define SWM_UWS_LISTEN_SOCKET_HANDLE_H

#include <App.h>
#include <v8.h>

namespace swm::binding {

class ListenSocketHandle final {
public:
    ListenSocketHandle(v8::Isolate *isolate, us_listen_socket_t *socket);
    ~ListenSocketHandle();

    ListenSocketHandle(const ListenSocketHandle &) = delete;
    ListenSocketHandle &operator=(const ListenSocketHandle &) = delete;

    [[nodiscard]] v8::Local<v8::External> Token() const;
    [[nodiscard]] bool Matches(v8::Local<v8::Value> token) const;
    [[nodiscard]] int LocalPort() const noexcept;

    void Close() noexcept;

private:
    v8::Isolate *isolate_;
    us_listen_socket_t *socket_;
    v8::Global<v8::External> token_;
};

} // namespace swm::binding

#endif // SWM_UWS_LISTEN_SOCKET_HANDLE_H
