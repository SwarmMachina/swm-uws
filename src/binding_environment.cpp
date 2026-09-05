#include "binding_environment.h"

#include "app_state.h"

namespace swm::binding {

BindingEnvironment::BindingEnvironment(v8::Isolate *isolate) noexcept : isolate_(isolate) {}

BindingEnvironment::~BindingEnvironment() {
    closing_ = true;
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
    apps_.emplace(ownedApp, std::move(app));
    return ownedApp;
}

void BindingEnvironment::ReleaseApp(AppState *app) {
    if (!closing_) apps_.erase(app);
}

bool BindingEnvironment::CloseListenSocket(v8::Local<v8::Value> token) {
    for (const auto &[pointer, app] : apps_) {
        if (app->CloseListenSocket(token)) return true;
    }
    return false;
}

std::optional<int> BindingEnvironment::ListenSocketLocalPort(v8::Local<v8::Value> token) const {
    for (const auto &[pointer, app] : apps_) {
        const std::optional<int> port = app->ListenSocketLocalPort(token);
        if (port) return port;
    }
    return std::nullopt;
}

} // namespace swm::binding
