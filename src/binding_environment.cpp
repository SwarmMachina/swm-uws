#include "binding_environment.h"

#include "app_state.h"
#include "upgrade_context_scope.h"

#include <algorithm>

namespace swm::binding {

BindingEnvironment::BindingEnvironment(v8::Isolate *isolate) noexcept : isolate_(isolate) {}

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

bool BindingEnvironment::CloseListenSocket(v8::Local<v8::Value> token) {
    for (const auto &app : apps_) {
        if (app->CloseListenSocket(token)) return true;
    }
    return false;
}

std::optional<int> BindingEnvironment::ListenSocketLocalPort(v8::Local<v8::Value> token) const {
    for (const auto &app : apps_) {
        const std::optional<int> port = app->ListenSocketLocalPort(token);
        if (port) return port;
    }
    return std::nullopt;
}

us_socket_context_t *
BindingEnvironment::ResolveUpgradeContext(v8::Local<v8::Value> token,
                                          uWS::HttpResponse<false> *response) const {
    for (auto iterator = activeUpgradeContexts_.rbegin(); iterator != activeUpgradeContexts_.rend();
         ++iterator) {
        if ((*iterator)->Matches(token, response)) return (*iterator)->NativeContext();
    }
    return nullptr;
}

void BindingEnvironment::RegisterUpgradeContext(UpgradeContextScope *scope) {
    activeUpgradeContexts_.push_back(scope);
}

void BindingEnvironment::UnregisterUpgradeContext(UpgradeContextScope *scope) {
    auto iterator = std::find(activeUpgradeContexts_.begin(), activeUpgradeContexts_.end(), scope);
    if (iterator != activeUpgradeContexts_.end()) activeUpgradeContexts_.erase(iterator);
}

} // namespace swm::binding
