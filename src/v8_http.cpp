#include <App.h>
#include <node.h>
#include <v8.h>

#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace {

using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::Boolean;
using v8::Context;
using v8::Exception;
using v8::External;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::NewStringType;
using v8::Object;
using v8::String;
using v8::Value;

using HttpResponse = uWS::HttpResponse<false>;

struct AppState {
    std::unique_ptr<uWS::App> app;
    us_listen_socket_t *listenSocket = nullptr;
    bool closed = false;
};

struct PerContextData {
    Isolate *isolate;
    Global<Object> responseTemplate;
    Global<Object> requestTemplate;
    Global<Function> appConstructor;
    std::vector<std::unique_ptr<AppState>> apps;
};

void *GetInternalPointer(const Local<Object> &object) {
#if V8_MAJOR_VERSION == 14
    return object->GetAlignedPointerFromInternalField(0, 0);
#else
    return object->GetAlignedPointerFromInternalField(0);
#endif
}

void SetInternalPointer(const Local<Object> &object, void *pointer) {
#if V8_MAJOR_VERSION == 14
    object->SetAlignedPointerInInternalField(0, pointer, 0);
#else
    object->SetAlignedPointerInInternalField(0, pointer);
#endif
}

Local<String> NewString(Isolate *isolate, std::string_view value) {
    return String::NewFromUtf8(
               isolate,
               value.data(),
               NewStringType::kNormal,
               static_cast<int>(value.length()))
        .ToLocalChecked();
}

void ThrowTypeError(Isolate *isolate, const char *message) {
    isolate->ThrowException(Exception::TypeError(NewString(isolate, message)));
}

void ThrowError(Isolate *isolate, const char *message) {
    isolate->ThrowException(Exception::Error(NewString(isolate, message)));
}

bool CallJs(Isolate *isolate, Local<Function> function, int argc, Local<Value> *argv) {
    return !node::MakeCallback(
                isolate,
                isolate->GetCurrentContext()->Global(),
                function,
                argc,
                argv,
                {0, 0})
                .IsEmpty();
}

class NativeBytes {
public:
    NativeBytes(Isolate *isolate, Local<Value> value, bool allowUndefined = false) {
        if (allowUndefined && value->IsUndefined()) {
            return;
        }

        if (value->IsString()) {
            Local<String> string = value.As<String>();
#if V8_MAJOR_VERSION >= 13
            const size_t length = string->Utf8LengthV2(isolate);
            owned_.resize(length);
            string->WriteUtf8V2(isolate, owned_.data(), length);
#else
            const int length = string->Utf8Length(isolate);
            owned_.resize(length);
            string->WriteUtf8(
                isolate,
                owned_.data(),
                length,
                nullptr,
                String::NO_NULL_TERMINATION);
#endif
            data_ = owned_.data();
            length_ = owned_.length();
            return;
        }

        if (value->IsArrayBufferView()) {
            Local<ArrayBufferView> view = value.As<ArrayBufferView>();
            std::shared_ptr<v8::BackingStore> backing = view->Buffer()->GetBackingStore();
            data_ = static_cast<const char *>(backing->Data()) + view->ByteOffset();
            length_ = view->ByteLength();
            return;
        }

        if (value->IsArrayBuffer()) {
            std::shared_ptr<v8::BackingStore> backing =
                value.As<ArrayBuffer>()->GetBackingStore();
            data_ = static_cast<const char *>(backing->Data());
            length_ = backing->ByteLength();
            return;
        }

        valid_ = false;
    }

    bool IsValid() const {
        return valid_;
    }

    std::string_view View() const {
        return {data_, length_};
    }

private:
    std::string owned_;
    const char *data_ = nullptr;
    std::size_t length_ = 0;
    bool valid_ = true;
};

HttpResponse *GetResponse(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = static_cast<HttpResponse *>(GetInternalPointer(args.This()));
    if (!response) {
        ThrowError(args.GetIsolate(), "HTTP response is no longer valid");
    }
    return response;
}

void ResponseEnd(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;

    Local<Value> bodyValue = args.Length() ? args[0] : v8::Undefined(args.GetIsolate());
    NativeBytes body(args.GetIsolate(), bodyValue, true);
    if (!body.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "res.end(body) expects a string or buffer");
        return;
    }

    response->end(body.View());
    SetInternalPointer(args.This(), nullptr);
    args.GetReturnValue().Set(args.This());
}

void ResponseWriteStatus(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "res.writeStatus(status) expects a string");
        return;
    }
    NativeBytes status(args.GetIsolate(), args[0]);
    response->writeStatus(status.View());
    args.GetReturnValue().Set(args.This());
}

void ResponseWriteHeader(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 2 || !args[0]->IsString() || !args[1]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "res.writeHeader(name, value) expects two strings");
        return;
    }
    NativeBytes name(args.GetIsolate(), args[0]);
    NativeBytes value(args.GetIsolate(), args[1]);
    response->writeHeader(name.View(), value.View());
    args.GetReturnValue().Set(args.This());
}

void RegisterGet(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    auto *context = static_cast<PerContextData *>(args.Data().As<External>()->Value());

    if (!state || args.Length() != 2 || !args[0]->IsString() || !args[1]->IsFunction()) {
        ThrowTypeError(isolate, "app.get(path, handler) expects a string and a function");
        return;
    }

    NativeBytes path(isolate, args[0]);
    Global<Function> handler(isolate, args[1].As<Function>());
    state->app->get(std::string(path.View()), [context, handler = std::move(handler)](
                                                  HttpResponse *response,
                                                  uWS::HttpRequest *) mutable {
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->responseTemplate.Get(callbackIsolate)->Clone();
        Local<Object> requestObject = context->requestTemplate.Get(callbackIsolate)->Clone();
        SetInternalPointer(responseObject, response);
        Local<Value> argv[] = {responseObject, requestObject};
        CallJs(callbackIsolate, handler.Get(callbackIsolate), 2, argv);

        if (GetInternalPointer(responseObject)) {
            response->close();
            SetInternalPointer(responseObject, nullptr);
        }
    });
    args.GetReturnValue().Set(args.This());
}

void AppListen(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 3 || !args[0]->IsString() ||
        !args[1]->IsNumber() || !args[2]->IsFunction()) {
        ThrowTypeError(isolate, "app.listen(host, port, callback) expects string, number, function");
        return;
    }
    if (state->closed) {
        ThrowError(isolate, "app.listen() cannot be called after app.close()");
        return;
    }
    if (state->listenSocket) {
        ThrowError(isolate, "app.listen() has already succeeded");
        return;
    }

    NativeBytes host(isolate, args[0]);
    const int port = args[1]->Int32Value(isolate->GetCurrentContext()).ToChecked();
    Global<Function> callback(isolate, args[2].As<Function>());
    state->app->listen(std::string(host.View()), port, [state, isolate, callback = std::move(callback)](
                                                           us_listen_socket_t *socket) mutable {
        state->listenSocket = socket;
        HandleScope scope(isolate);
        Local<Value> argv[] = {Boolean::New(isolate, socket != nullptr)};
        CallJs(isolate, callback.Get(isolate), 1, argv);
    });
    args.GetReturnValue().Set(args.This());
}

void AppClose(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state) return;
    if (!state->closed) {
        state->closed = true;
        if (state->listenSocket) {
            us_listen_socket_close(0, state->listenSocket);
            state->listenSocket = nullptr;
        }
    }
    args.GetReturnValue().Set(args.This());
}

void CreateApp(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *context = static_cast<PerContextData *>(args.Data().As<External>()->Value());
    auto state = std::make_unique<AppState>();
    state->app = std::make_unique<uWS::App>();
    AppState *statePointer = state.get();
    context->apps.push_back(std::move(state));
    Local<Object> app = context->appConstructor.Get(isolate)
                            ->NewInstance(isolate->GetCurrentContext())
                            .ToLocalChecked();
    SetInternalPointer(app, statePointer);
    args.GetReturnValue().Set(app);
}

void Version(const FunctionCallbackInfo<Value> &args) {
    args.GetReturnValue().Set(NewString(args.GetIsolate(), "v8-http-prototype"));
}

PerContextData *Initialize(Isolate *isolate, Local<Object> exports) {
    auto *context = new PerContextData;
    context->isolate = isolate;
    Local<External> contextExternal = External::New(isolate, context);

    Local<FunctionTemplate> response = FunctionTemplate::New(isolate);
    response->InstanceTemplate()->SetInternalFieldCount(1);
    response->PrototypeTemplate()->Set(isolate, "end", FunctionTemplate::New(isolate, ResponseEnd));
    response->PrototypeTemplate()->Set(
        isolate,
        "writeStatus",
        FunctionTemplate::New(isolate, ResponseWriteStatus));
    response->PrototypeTemplate()->Set(
        isolate,
        "writeHeader",
        FunctionTemplate::New(isolate, ResponseWriteHeader));
    context->responseTemplate.Reset(
        isolate,
        response->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> request = FunctionTemplate::New(isolate);
    request->InstanceTemplate()->SetInternalFieldCount(1);
    context->requestTemplate.Reset(
        isolate,
        request->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> app = FunctionTemplate::New(isolate);
    app->InstanceTemplate()->SetInternalFieldCount(1);
    app->PrototypeTemplate()->Set(
        isolate,
        "get",
        FunctionTemplate::New(isolate, RegisterGet, contextExternal));
    app->PrototypeTemplate()->Set(
        isolate,
        "listen",
        FunctionTemplate::New(isolate, AppListen));
    app->PrototypeTemplate()->Set(
        isolate,
        "close",
        FunctionTemplate::New(isolate, AppClose));
    context->appConstructor.Reset(
        isolate,
        app->GetFunction(isolate->GetCurrentContext()).ToLocalChecked());

    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "createApp"),
            FunctionTemplate::New(isolate, CreateApp, contextExternal)
                ->GetFunction(isolate->GetCurrentContext())
                .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "version"),
            FunctionTemplate::New(isolate, Version)
                ->GetFunction(isolate->GetCurrentContext())
                .ToLocalChecked())
        .ToChecked();
    return context;
}

}  // namespace

void InitializeModule(
    Local<Object> exports,
    Local<Value>,
    Local<Context> context,
    void *) {
    Isolate *isolate = context->GetIsolate();
    uWS::Loop::get(node::GetCurrentEventLoop(isolate));
    PerContextData *data = Initialize(isolate, exports);
    node::AddEnvironmentCleanupHook(
        isolate,
        [](void *argument) {
            auto *contextData = static_cast<PerContextData *>(argument);
            contextData->apps.clear();
            contextData->responseTemplate.Reset();
            contextData->requestTemplate.Reset();
            contextData->appConstructor.Reset();
            uWS::Loop::get()->free();
            delete contextData;
        },
        data);
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitializeModule)
