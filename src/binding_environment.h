#ifndef SWM_UWS_BINDING_ENVIRONMENT_H
#define SWM_UWS_BINDING_ENVIRONMENT_H

#include <App.h>
#include <v8.h>

#include <memory>
#include <vector>

namespace swm::binding {

class AppState;

class BindingEnvironment final {
public:
    explicit BindingEnvironment(v8::Isolate *isolate) noexcept : isolate_(isolate) {}

    ~BindingEnvironment();

    BindingEnvironment(const BindingEnvironment &) = delete;
    BindingEnvironment &operator=(const BindingEnvironment &) = delete;

    [[nodiscard]] v8::Isolate *Isolate() const noexcept {
        return isolate_;
    }

    [[nodiscard]] v8::Local<v8::Object> CloneResponseTemplate() const {
        return responseTemplate_.Get(isolate_)->Clone();
    }

    [[nodiscard]] v8::Local<v8::Object> CloneRequestTemplate() const {
        return requestTemplate_.Get(isolate_)->Clone();
    }

    [[nodiscard]] v8::Local<v8::Object> CloneRequestPrefetchSnapshotTemplate() const {
        return requestPrefetchSnapshotTemplate_.Get(isolate_)->Clone();
    }

    [[nodiscard]] v8::Local<v8::Object> CloneRequestPrefetchHeadersTemplate() const {
        return requestPrefetchHeadersTemplate_.Get(isolate_)->Clone();
    }

    [[nodiscard]] v8::Local<v8::Object> CloneSocketTemplate() const {
        return socketTemplate_.Get(isolate_)->Clone();
    }

    [[nodiscard]] v8::Local<v8::Function> AppConstructor() const {
        return appConstructor_.Get(isolate_);
    }

    [[nodiscard]] v8::Local<v8::Function> RequestPrefetchPlanConstructor() const {
        return requestPrefetchPlanConstructor_.Get(isolate_);
    }

    void SetResponseTemplate(v8::Local<v8::Object> value) {
        responseTemplate_.Reset(isolate_, value);
    }

    void SetRequestTemplate(v8::Local<v8::Object> value) {
        requestTemplate_.Reset(isolate_, value);
    }

    void SetRequestPrefetchSnapshotTemplate(v8::Local<v8::Object> value) {
        requestPrefetchSnapshotTemplate_.Reset(isolate_, value);
    }

    void SetRequestPrefetchHeadersTemplate(v8::Local<v8::Object> value) {
        requestPrefetchHeadersTemplate_.Reset(isolate_, value);
    }

    void SetSocketTemplate(v8::Local<v8::Object> value) {
        socketTemplate_.Reset(isolate_, value);
    }

    void SetAppConstructor(v8::Local<v8::Function> value) {
        appConstructor_.Reset(isolate_, value);
    }

    void SetRequestPrefetchPlanConstructor(v8::Local<v8::Function> value) {
        requestPrefetchPlanConstructor_.Reset(isolate_, value);
    }

    [[nodiscard]] bool IsKnownResponseHeaderName(v8::Local<v8::String> value) const {
        return responseHeaderNameValidation_.Matches(isolate_, value);
    }

    void RememberResponseHeaderName(v8::Local<v8::String> value) {
        responseHeaderNameValidation_.Store(isolate_, value);
    }

    [[nodiscard]] bool IsKnownResponseHeaderValue(v8::Local<v8::String> value) const {
        return responseHeaderValueValidation_.Matches(isolate_, value);
    }

    void RememberResponseHeaderValue(v8::Local<v8::String> value) {
        responseHeaderValueValidation_.Store(isolate_, value);
    }

    AppState *OwnApp(std::unique_ptr<AppState> app);
    void ForgetListenSocket(us_listen_socket_t *socket);

private:
    class ValidatedStringCache final {
    public:
        [[nodiscard]] bool Matches(v8::Isolate *isolate, v8::Local<v8::String> value) const {
            return !key_.IsEmpty() && key_.Get(isolate)->StrictEquals(value);
        }

        void Store(v8::Isolate *isolate, v8::Local<v8::String> value) {
            key_.Reset(isolate, value);
        }

    private:
        v8::Global<v8::String> key_;
    };

    v8::Isolate *isolate_;
    v8::Global<v8::Object> responseTemplate_;
    v8::Global<v8::Object> requestTemplate_;
    v8::Global<v8::Object> requestPrefetchSnapshotTemplate_;
    v8::Global<v8::Object> requestPrefetchHeadersTemplate_;
    v8::Global<v8::Object> socketTemplate_;
    v8::Global<v8::Function> appConstructor_;
    v8::Global<v8::Function> requestPrefetchPlanConstructor_;
    ValidatedStringCache responseHeaderNameValidation_;
    ValidatedStringCache responseHeaderValueValidation_;
    std::vector<std::unique_ptr<AppState>> apps_;
};

} // namespace swm::binding

#endif // SWM_UWS_BINDING_ENVIRONMENT_H
