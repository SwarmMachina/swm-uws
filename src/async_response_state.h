#ifndef SWM_UWS_ASYNC_RESPONSE_STATE_H
#define SWM_UWS_ASYNC_RESPONSE_STATE_H

#include <App.h>
#include <v8.h>

#include <memory>

namespace swm::binding {

using HttpResponse = uWS::HttpResponse<false>;

class AsyncResponseState final : public std::enable_shared_from_this<AsyncResponseState> {
public:
    AsyncResponseState(v8::Isolate *isolate, HttpResponse *response, v8::Local<v8::Object> object)
        : isolate_(isolate), response_(response), valid_(true), object_(isolate, object) {}

    AsyncResponseState(const AsyncResponseState &) = delete;
    AsyncResponseState &operator=(const AsyncResponseState &) = delete;

    [[nodiscard]] v8::Isolate *Isolate() const noexcept {
        return isolate_;
    }

    [[nodiscard]] HttpResponse *Response() const noexcept {
        return response_;
    }

    [[nodiscard]] bool IsValid() const noexcept {
        return valid_;
    }

    [[nodiscard]] v8::Local<v8::Object> Object() const {
        return object_.Get(isolate_);
    }

    void Invalidate() {
        response_ = nullptr;
        valid_ = false;
        dataHandler_.Reset();
        abortedHandler_.Reset();
        writableHandler_.Reset();
        object_.Reset();
    }

    [[nodiscard]] bool HasDataHandler() const noexcept {
        return dataHandlerRegistered_;
    }

    void RegisterDataHandler(v8::Local<v8::Function> handler) {
        dataHandlerRegistered_ = true;
        dataHandler_.Reset(isolate_, handler);
    }

    [[nodiscard]] bool HasActiveDataHandler() const noexcept {
        return !dataHandler_.IsEmpty();
    }

    [[nodiscard]] v8::Local<v8::Function> DataHandler() const {
        return dataHandler_.Get(isolate_);
    }

    void ResetDataHandler() {
        dataHandler_.Reset();
    }

    [[nodiscard]] bool HasAbortedHandler() const noexcept {
        return abortedHandlerRegistered_;
    }

    void RegisterAbortedHandler(v8::Local<v8::Function> handler) {
        abortedHandlerRegistered_ = true;
        abortedHandler_.Reset(isolate_, handler);
    }

    [[nodiscard]] bool HasActiveAbortedHandler() const noexcept {
        return !abortedHandler_.IsEmpty();
    }

    [[nodiscard]] v8::Local<v8::Function> AbortedHandler() const {
        return abortedHandler_.Get(isolate_);
    }

    [[nodiscard]] bool HasWritableHandler() const noexcept {
        return writableHandlerRegistered_;
    }

    void RegisterWritableHandler(v8::Local<v8::Function> handler) {
        writableHandlerRegistered_ = true;
        writableHandler_.Reset(isolate_, handler);
    }

    [[nodiscard]] bool HasActiveWritableHandler() const noexcept {
        return !writableHandler_.IsEmpty();
    }

    [[nodiscard]] v8::Local<v8::Function> WritableHandler() const {
        return writableHandler_.Get(isolate_);
    }

private:
    v8::Isolate *isolate_;
    HttpResponse *response_;
    bool valid_;
    bool dataHandlerRegistered_ = false;
    bool abortedHandlerRegistered_ = false;
    bool writableHandlerRegistered_ = false;
    v8::Global<v8::Function> dataHandler_;
    v8::Global<v8::Function> abortedHandler_;
    v8::Global<v8::Function> writableHandler_;
    v8::Global<v8::Object> object_;
};

} // namespace swm::binding

#endif // SWM_UWS_ASYNC_RESPONSE_STATE_H
