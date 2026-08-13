#ifndef SWM_UWS_HTTP_ROUTE_CALLBACK_SCOPE_H
#define SWM_UWS_HTTP_ROUTE_CALLBACK_SCOPE_H

namespace swm::binding {

class AppState;

class HttpRouteCallbackScope final {
public:
    explicit HttpRouteCallbackScope(AppState &app) noexcept;
    ~HttpRouteCallbackScope();

    HttpRouteCallbackScope(const HttpRouteCallbackScope &) = delete;
    HttpRouteCallbackScope &operator=(const HttpRouteCallbackScope &) = delete;

private:
    AppState &app_;
};

} // namespace swm::binding

#endif // SWM_UWS_HTTP_ROUTE_CALLBACK_SCOPE_H
