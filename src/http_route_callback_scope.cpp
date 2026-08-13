#include "http_route_callback_scope.h"

#include "app_state.h"

namespace swm::binding {

HttpRouteCallbackScope::HttpRouteCallbackScope(AppState &app) noexcept : app_(app) {
    app_.EnterHttpRouteCallback();
}

HttpRouteCallbackScope::~HttpRouteCallbackScope() {
    app_.LeaveHttpRouteCallback();
}

} // namespace swm::binding
