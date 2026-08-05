#include "binding_environment.h"

#include "app_state.h"

namespace swm::binding {

BindingEnvironment::~BindingEnvironment() {
    apps_.clear();
    responseTemplate_.Reset();
    requestTemplate_.Reset();
    requestPrefetchSnapshotTemplate_.Reset();
    requestPrefetchHeadersTemplate_.Reset();
    socketTemplate_.Reset();
    appConstructor_.Reset();
    requestPrefetchPlanConstructor_.Reset();
}

AppState *BindingEnvironment::OwnApp(std::unique_ptr<AppState> app) {
    AppState *ownedApp = app.get();
    apps_.push_back(std::move(app));
    return ownedApp;
}

void BindingEnvironment::ForgetListenSocket(us_listen_socket_t *socket) {
    for (const auto &app : apps_) app->ForgetListenSocket(socket);
}

} // namespace swm::binding
