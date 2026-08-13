#ifndef SWM_UWS_APP_STATE_H
#define SWM_UWS_APP_STATE_H

#include <App.h>
#include <v8.h>

#include <cstddef>
#include <memory>
#include <optional>
#include <vector>

namespace swm::binding {

class BindingEnvironment;
class ListenSocketHandle;

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

    [[nodiscard]] bool IsInFilterCallback() const noexcept {
        return filterCallbackDepth_ != 0;
    }

    void EnterFilterCallback() noexcept {
        filterCallbackDepth_++;
    }

    void LeaveFilterCallback() noexcept {
        if (filterCallbackDepth_) filterCallbackDepth_--;
    }

    [[nodiscard]] bool IsInHttpRouteCallback() const noexcept {
        return httpRouteCallbackDepth_ != 0;
    }

    void EnterHttpRouteCallback() noexcept {
        httpRouteCallbackDepth_++;
    }

    void LeaveHttpRouteCallback() noexcept {
        if (httpRouteCallbackDepth_) httpRouteCallbackDepth_--;
    }

    void EnterNativeCallback() noexcept {
        nativeCallbackDepth_++;
    }

    void LeaveNativeCallback() noexcept;

    v8::Global<v8::Function> *OwnHandler(v8::Isolate *isolate, v8::Local<v8::Function> handler);
    v8::Global<v8::Function> *OwnHandler(std::unique_ptr<v8::Global<v8::Function>> handler);

    [[nodiscard]] ListenSocketHandle *TrackListenSocket(us_listen_socket_t *socket);
    [[nodiscard]] bool CloseListenSocket(v8::Local<v8::Value> token);
    [[nodiscard]] bool CloseListenSocket(ListenSocketHandle *handle);
    [[nodiscard]] std::optional<int> ListenSocketLocalPort(v8::Local<v8::Value> token) const;
    void Close() noexcept;

private:
    BindingEnvironment &environment_;
    std::unique_ptr<uWS::App> app_;
    std::vector<std::unique_ptr<ListenSocketHandle>> listenSockets_;
    std::vector<std::unique_ptr<v8::Global<v8::Function>>> handlers_;
    bool closed_ = false;
    bool hasWebSockets_ = false;
    bool nativeClosePending_ = false;
    std::size_t filterCallbackDepth_ = 0;
    std::size_t httpRouteCallbackDepth_ = 0;
    std::size_t nativeCallbackDepth_ = 0;
};

} // namespace swm::binding

#endif // SWM_UWS_APP_STATE_H
