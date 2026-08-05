#ifndef SWM_UWS_APP_STATE_H
#define SWM_UWS_APP_STATE_H

#include <App.h>
#include <v8.h>

#include <memory>
#include <vector>

namespace swm::binding {

class BindingEnvironment;

class AppState final {
public:
    AppState(BindingEnvironment &environment, std::unique_ptr<uWS::App> app) noexcept;
    ~AppState();

    AppState(const AppState &) = delete;
    AppState &operator=(const AppState &) = delete;

    [[nodiscard]] uWS::App &NativeApp() noexcept {
        return *app_;
    }

    [[nodiscard]] const uWS::App &NativeApp() const noexcept {
        return *app_;
    }

    [[nodiscard]] BindingEnvironment &Environment() const noexcept {
        return environment_;
    }

    [[nodiscard]] bool IsClosed() const noexcept {
        return closed_;
    }

    [[nodiscard]] bool HasWebSockets() const noexcept {
        return hasWebSockets_;
    }

    void EnableWebSockets() noexcept {
        hasWebSockets_ = true;
    }

    v8::Global<v8::Function> *OwnHandler(v8::Isolate *isolate, v8::Local<v8::Function> handler);
    v8::Global<v8::Function> *OwnHandler(std::unique_ptr<v8::Global<v8::Function>> handler);

    void TrackListenSocket(us_listen_socket_t *socket);
    void ForgetListenSocket(us_listen_socket_t *socket);
    void CloseListenSocket(us_listen_socket_t *socket);
    void Close() noexcept;

private:
    BindingEnvironment &environment_;
    std::unique_ptr<uWS::App> app_;
    std::vector<us_listen_socket_t *> listenSockets_;
    std::vector<std::unique_ptr<v8::Global<v8::Function>>> handlers_;
    bool closed_ = false;
    bool hasWebSockets_ = false;
};

} // namespace swm::binding

#endif // SWM_UWS_APP_STATE_H
