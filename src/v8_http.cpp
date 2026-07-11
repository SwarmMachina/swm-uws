#include <App.h>
#include <node.h>
#include <v8.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace {

using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::Array;
using v8::Boolean;
using v8::Context;
using v8::Exception;
using v8::External;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::HandleScope;
using v8::Isolate;
using v8::Local;
using v8::NewStringType;
using v8::Number;
using v8::Object;
using v8::String;
using v8::Value;

using HttpResponse = uWS::HttpResponse<false>;

enum class HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Head,
    Any,
};

struct PerContextData;

struct AppState {
    std::unique_ptr<uWS::App> app;
    PerContextData *context = nullptr;
    us_listen_socket_t *listenSocket = nullptr;
    bool closed = false;
    std::vector<std::unique_ptr<Global<Function>>> handlers;
};

struct PerContextData {
    Isolate *isolate;
    Global<Object> responseTemplate;
    Global<Object> requestTemplate;
    Global<Function> appConstructor;
    std::vector<std::unique_ptr<AppState>> apps;
};

struct AsyncResponseState : std::enable_shared_from_this<AsyncResponseState> {
    Isolate *isolate = nullptr;
    HttpResponse *response = nullptr;
    bool valid = false;
    bool dataHandlerRegistered = false;
    bool abortedHandlerRegistered = false;
    bool writableHandlerRegistered = false;
    Global<Function> dataHandler;
    Global<Function> abortedHandler;
    Global<Function> writableHandler;
    Global<Object> object;
};

void *GetInternalPointer(const Local<Object> &object, int index = 0) {
#if V8_MAJOR_VERSION == 14
    return object->GetAlignedPointerFromInternalField(index, 0);
#else
    return object->GetAlignedPointerFromInternalField(index);
#endif
}

void SetInternalPointer(const Local<Object> &object, void *pointer, int index = 0) {
#if V8_MAJOR_VERSION == 14
    object->SetAlignedPointerInInternalField(index, pointer, 0);
#else
    object->SetAlignedPointerInInternalField(index, pointer);
#endif
}

Local<String> NewString(Isolate *isolate, std::string_view value) {
    if (value.empty()) return String::Empty(isolate);
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

Local<Value> CallJsValue(
    Isolate *isolate,
    Local<Function> function,
    int argc,
    Local<Value> *argv) {
    Local<Value> result;
    if (!node::MakeCallback(
             isolate,
             isolate->GetCurrentContext()->Global(),
             function,
             argc,
             argv,
             {0, 0})
             .ToLocal(&result)) {
        return v8::Undefined(isolate);
    }
    return result;
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

bool IsHttpTokenCharacter(unsigned char character) {
    if ((character >= '0' && character <= '9') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= 'a' && character <= 'z')) {
        return true;
    }

    switch (character) {
        case '!':
        case '#':
        case '$':
        case '%':
        case '&':
        case '\'':
        case '*':
        case '+':
        case '-':
        case '.':
        case '^':
        case '_':
        case '`':
        case '|':
        case '~':
            return true;
        default:
            return false;
    }
}

bool IsValidHeaderName(std::string_view name) {
    return !name.empty() && std::all_of(name.begin(), name.end(), [](unsigned char character) {
        return IsHttpTokenCharacter(character);
    });
}

bool ContainsInvalidHeaderValueCharacter(std::string_view value) {
    return std::any_of(value.begin(), value.end(), [](unsigned char character) {
        return (character < 0x20 && character != '\t') || character == 0x7f;
    });
}

bool IsValidStatus(std::string_view status) {
    if (status.length() < 3 || status[0] < '1' || status[0] > '9' ||
        status[1] < '0' || status[1] > '9' || status[2] < '0' || status[2] > '9') {
        return false;
    }

    return (status.length() == 3 || status[3] == ' ') &&
        !ContainsInvalidHeaderValueCharacter(status);
}

HttpResponse *GetResponse(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = static_cast<HttpResponse *>(GetInternalPointer(args.This()));
    if (!response) {
        ThrowError(args.GetIsolate(), "HTTP response is no longer valid");
    }
    return response;
}

void InvalidateResponseObject(Local<Object> object) {
    SetInternalPointer(object, nullptr, 0);
    SetInternalPointer(object, nullptr, 1);
}

void InvalidateAsyncResponse(const std::shared_ptr<AsyncResponseState> &state) {
    if (!state->valid) return;
    Local<Object> object = state->object.Get(state->isolate);
    InvalidateResponseObject(object);
    state->response = nullptr;
    state->valid = false;
    state->dataHandler.Reset();
    state->abortedHandler.Reset();
    state->writableHandler.Reset();
    state->object.Reset();
}

std::shared_ptr<AsyncResponseState> PromoteResponse(
    const FunctionCallbackInfo<Value> &args) {
    auto *existing = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    if (existing) {
        return existing->shared_from_this();
    }

    auto state = std::make_shared<AsyncResponseState>();
    state->isolate = args.GetIsolate();
    state->response = static_cast<HttpResponse *>(GetInternalPointer(args.This()));
    state->valid = true;
    state->object.Reset(args.GetIsolate(), args.This());
    SetInternalPointer(args.This(), state.get(), 1);
    state->response->onAborted([state]() {
        Isolate *isolate = state->isolate;
        HandleScope scope(isolate);
        Local<Function> handler;
        const bool hasHandler = !state->abortedHandler.IsEmpty();
        if (hasHandler) handler = state->abortedHandler.Get(isolate);
        InvalidateAsyncResponse(state);
        if (hasHandler) CallJs(isolate, handler, 0, nullptr);
    });
    return state;
}

void ResponseEnd(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;

    Local<Value> bodyValue = v8::Undefined(args.GetIsolate());
    if (args.Length()) bodyValue = args[0];
    NativeBytes body(args.GetIsolate(), bodyValue, true);
    if (!body.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "res.end(body) expects a string or buffer");
        return;
    }
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    response->end(body.View());

    if (asyncState) {
        InvalidateAsyncResponse(asyncState);
    } else {
        InvalidateResponseObject(args.This());
    }
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
    if (!IsValidStatus(status.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeStatus(status) expects a three-digit status without control characters");
        return;
    }
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
    if (!IsValidHeaderName(name.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader(name, value) expects a valid HTTP header name");
        return;
    }
    if (ContainsInvalidHeaderValueCharacter(value.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader(name, value) does not allow control characters in value");
        return;
    }
    response->writeHeader(name.View(), value.View());
    args.GetReturnValue().Set(args.This());
}

void ResponseCork(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "res.cork(handler) expects a function");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Function> handler = args[0].As<Function>();
    HttpResponse *updated = response->cork([isolate, handler]() {
        CallJs(isolate, handler, 0, nullptr);
    });
    if (GetInternalPointer(args.This())) SetInternalPointer(args.This(), updated);
    args.GetReturnValue().Set(args.This());
}

void ResponseWrite(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "res.write(chunk) expects a string or buffer");
        return;
    }
    NativeBytes chunk(args.GetIsolate(), args[0]);
    if (!chunk.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "res.write(chunk) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(Boolean::New(args.GetIsolate(), response->write(chunk.View())));
}

void ResponseTryEnd(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 2 || !args[1]->IsNumber()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.tryEnd(chunk, totalSize) expects a string or buffer and a number");
        return;
    }
    NativeBytes chunk(args.GetIsolate(), args[0]);
    const double totalNumber = args[1]->NumberValue(args.GetIsolate()->GetCurrentContext())
                                   .FromMaybe(-1);
    if (!chunk.IsValid() || !std::isfinite(totalNumber) || totalNumber < 0 ||
        totalNumber > 9007199254740991.0 || std::floor(totalNumber) != totalNumber) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.tryEnd(chunk, totalSize) expects a string or buffer and a valid size");
        return;
    }
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    const auto [ok, done] = response->tryEnd(
        chunk.View(),
        static_cast<uintmax_t>(totalNumber));
    Local<Array> result = Array::New(args.GetIsolate(), 2);
    result->Set(args.GetIsolate()->GetCurrentContext(), 0, Boolean::New(args.GetIsolate(), ok))
        .ToChecked();
    result->Set(args.GetIsolate()->GetCurrentContext(), 1, Boolean::New(args.GetIsolate(), done))
        .ToChecked();
    if (done) {
        if (asyncState) InvalidateAsyncResponse(asyncState);
        else InvalidateResponseObject(args.This());
    }
    args.GetReturnValue().Set(result);
}

void ResponseOnWritable(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "res.onWritable(handler) expects a function");
        return;
    }
    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->writableHandlerRegistered) {
        ThrowError(args.GetIsolate(), "res.onWritable() handler is already registered");
        return;
    }
    state->writableHandlerRegistered = true;
    state->writableHandler.Reset(args.GetIsolate(), args[0].As<Function>());
    state->response->onWritable([state](uintmax_t offset) {
        if (!state->valid || state->writableHandler.IsEmpty()) return false;
        Isolate *isolate = state->isolate;
        HandleScope scope(isolate);
        Local<Value> argv[] = {Number::New(isolate, static_cast<double>(offset))};
        return CallJsValue(isolate, state->writableHandler.Get(isolate), 1, argv)
            ->BooleanValue(isolate);
    });
    args.GetReturnValue().Set(args.This());
}

void ResponseGetWriteOffset(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.getWriteOffset() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        Number::New(args.GetIsolate(), static_cast<double>(response->getWriteOffset())));
}

Local<ArrayBuffer> CopyToArrayBuffer(Isolate *isolate, std::string_view value) {
    std::unique_ptr<v8::BackingStore> backing =
        ArrayBuffer::NewBackingStore(isolate, value.length());
    if (!value.empty()) std::memcpy(backing->Data(), value.data(), value.length());
    return ArrayBuffer::New(isolate, std::move(backing));
}

void ResponseGetRemoteAddressAsText(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.getRemoteAddressAsText() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), response->getRemoteAddressAsText()));
}

void ResponseOnData(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "res.onData(handler) expects a function");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->dataHandlerRegistered) {
        ThrowError(args.GetIsolate(), "res.onData() handler is already registered");
        return;
    }
    state->dataHandlerRegistered = true;
    state->dataHandler.Reset(args.GetIsolate(), args[0].As<Function>());
    state->response->onData([state](std::string_view chunk, bool isLast) {
        if (!state->valid || state->dataHandler.IsEmpty()) return;
        Isolate *isolate = state->isolate;
        HandleScope scope(isolate);
        std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
            const_cast<char *>(chunk.data()),
            chunk.length(),
            [](void *, size_t, void *) {},
            nullptr);
        Local<ArrayBuffer> buffer = ArrayBuffer::New(isolate, std::move(backing));
        Local<Value> argv[] = {buffer, Boolean::New(isolate, isLast)};
        CallJs(isolate, state->dataHandler.Get(isolate), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
    });
    args.GetReturnValue().Set(args.This());
}

void ResponseOnAborted(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "res.onAborted(handler) expects a function");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->abortedHandlerRegistered) {
        ThrowError(args.GetIsolate(), "res.onAborted() handler is already registered");
        return;
    }
    state->abortedHandlerRegistered = true;
    state->abortedHandler.Reset(args.GetIsolate(), args[0].As<Function>());
    args.GetReturnValue().Set(args.This());
}

uWS::HttpRequest *GetRequest(const FunctionCallbackInfo<Value> &args) {
    auto *request = static_cast<uWS::HttpRequest *>(GetInternalPointer(args.This()));
    if (!request) ThrowError(args.GetIsolate(), "HTTP request is no longer valid");
    return request;
}

void RequestGetMethod(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "req.getMethod() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getMethod()));
}

void RequestGetUrl(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "req.getUrl() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getUrl()));
}

void RequestGetHeader(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "req.getHeader(name) expects a string");
        return;
    }
    NativeBytes nativeName(args.GetIsolate(), args[0]);
    if (!IsValidHeaderName(nativeName.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "req.getHeader(name) expects a valid HTTP header name");
        return;
    }
    std::string name(nativeName.View());
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
        return character >= 'A' && character <= 'Z'
            ? static_cast<char>(character + ('a' - 'A'))
            : static_cast<char>(character);
    });
    args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getHeader(name)));
}

void RequestGetQuery(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() == 0) {
        args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getQuery()));
        return;
    }
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "req.getQuery(key) expects a string");
        return;
    }
    NativeBytes key(args.GetIsolate(), args[0]);
    std::string_view value = request->getQuery(key.View());
    if (value.data()) args.GetReturnValue().Set(NewString(args.GetIsolate(), value));
}

void RequestGetParameter(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1 || !args[0]->IsNumber()) {
        ThrowTypeError(args.GetIsolate(), "req.getParameter(index) expects a number");
        return;
    }
    const double indexNumber = args[0]->NumberValue(args.GetIsolate()->GetCurrentContext())
                                   .FromMaybe(-1);
    if (!std::isfinite(indexNumber) || indexNumber < 0 || indexNumber > 65535 ||
        std::floor(indexNumber) != indexNumber) {
        ThrowTypeError(args.GetIsolate(), "req.getParameter(index) expects a valid index");
        return;
    }
    std::string_view value = request->getParameter(
        static_cast<unsigned short>(indexNumber));
    if (value.data()) args.GetReturnValue().Set(NewString(args.GetIsolate(), value));
}

void RequestForEach(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "req.forEach(handler) expects a function");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Function> handler = args[0].As<Function>();
    for (const auto &[name, value] : *request) {
        Local<Value> argv[] = {NewString(isolate, name), NewString(isolate, value)};
        if (!CallJs(isolate, handler, 2, argv)) return;
    }
}

void RegisterHttpRoute(
    const FunctionCallbackInfo<Value> &args,
    HttpMethod method,
    const char *methodName) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 2 || !args[0]->IsString() || !args[1]->IsFunction()) {
        std::string message = "app." + std::string(methodName) +
            "(path, handler) expects a string and a function";
        ThrowTypeError(isolate, message.c_str());
        return;
    }

    NativeBytes path(isolate, args[0]);
    auto handler = std::make_unique<Global<Function>>(isolate, args[1].As<Function>());
    Global<Function> *handlerPointer = handler.get();
    state->handlers.push_back(std::move(handler));
    PerContextData *context = state->context;
    auto routeHandler = [context, handlerPointer](
                            HttpResponse *response,
                            uWS::HttpRequest *request) {
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->responseTemplate.Get(callbackIsolate)->Clone();
        Local<Object> requestObject = context->requestTemplate.Get(callbackIsolate)->Clone();
        SetInternalPointer(responseObject, response, 0);
        SetInternalPointer(responseObject, nullptr, 1);
        SetInternalPointer(requestObject, request);
        Local<Value> argv[] = {responseObject, requestObject};
        CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        SetInternalPointer(requestObject, nullptr);

        if (GetInternalPointer(responseObject)) {
            auto *async = static_cast<AsyncResponseState *>(
                GetInternalPointer(responseObject, 1));
            if (!async) {
                response->close();
                InvalidateResponseObject(responseObject);
            }
        }
    };

    const std::string pathString(path.View());
    switch (method) {
        case HttpMethod::Get:
            state->app->get(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Post:
            state->app->post(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Put:
            state->app->put(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Patch:
            state->app->patch(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Delete:
            state->app->del(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Options:
            state->app->options(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Head:
            state->app->head(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Any:
            state->app->any(pathString, std::move(routeHandler));
            break;
    }
    args.GetReturnValue().Set(args.This());
}

void AppGet(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Get, "get");
}
void AppPost(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Post, "post");
}
void AppPut(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Put, "put");
}
void AppPatch(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Patch, "patch");
}
void AppDelete(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Delete, "del");
}
void AppOptions(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Options, "options");
}
void AppHead(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Head, "head");
}
void AppAny(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Any, "any");
}

void AppListen(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    const bool portOnly = args.Length() == 2 && args[0]->IsNumber() &&
        args[1]->IsFunction();
    const bool withHost = args.Length() == 3 && args[0]->IsString() &&
        args[1]->IsNumber() && args[2]->IsFunction();
    if (!state || (!portOnly && !withHost)) {
        ThrowTypeError(
            isolate,
            "app.listen() expects (port, callback) or (host, port, callback)");
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

    const int portIndex = withHost ? 1 : 0;
    const int callbackIndex = withHost ? 2 : 1;
    const int port = args[portIndex]->Int32Value(isolate->GetCurrentContext()).ToChecked();
    if (port < 1 || port > 65535) {
        ThrowTypeError(isolate, "app.listen() port must be between 1 and 65535");
        return;
    }
    auto callback = std::make_unique<Global<Function>>(
        isolate,
        args[callbackIndex].As<Function>());
    Global<Function> *callbackPointer = callback.get();
    state->handlers.push_back(std::move(callback));
    auto listener = [state, isolate, callbackPointer](us_listen_socket_t *socket) {
        state->listenSocket = socket;
        HandleScope scope(isolate);
        Local<Value> socketValue = v8::False(isolate);
        if (socket) socketValue = External::New(isolate, socket);
        Local<Value> argv[] = {socketValue};
        CallJs(isolate, callbackPointer->Get(isolate), 1, argv);
    };
    if (withHost) {
        NativeBytes host(isolate, args[0]);
        state->app->listen(std::string(host.View()), port, std::move(listener));
    } else {
        state->app->listen(port, std::move(listener));
    }
    args.GetReturnValue().Set(args.This());
}

void AppClose(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "app.close() does not accept arguments");
        return;
    }
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
    state->context = context;
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

void CloseListenSocket(const FunctionCallbackInfo<Value> &args) {
    if (args.Length() != 1 || !args[0]->IsExternal()) {
        ThrowTypeError(args.GetIsolate(), "us_listen_socket_close(socket) expects a listen socket");
        return;
    }
    auto *socket = static_cast<us_listen_socket_t *>(args[0].As<External>()->Value());
    if (!socket) return;
    auto *context = static_cast<PerContextData *>(args.Data().As<External>()->Value());
    for (const auto &app : context->apps) {
        if (app->listenSocket == socket) {
            app->listenSocket = nullptr;
            break;
        }
    }
    us_listen_socket_close(0, socket);
}

void SetPrototypeMethod(
    Isolate *isolate,
    Local<FunctionTemplate> target,
    const char *name,
    v8::FunctionCallback callback) {
    target->PrototypeTemplate()->Set(
        isolate,
        name,
        FunctionTemplate::New(isolate, callback));
}

PerContextData *Initialize(Isolate *isolate, Local<Object> exports) {
    auto *context = new PerContextData;
    context->isolate = isolate;
    Local<External> contextExternal = External::New(isolate, context);

    Local<FunctionTemplate> response = FunctionTemplate::New(isolate);
    response->InstanceTemplate()->SetInternalFieldCount(2);
    SetPrototypeMethod(isolate, response, "end", ResponseEnd);
    SetPrototypeMethod(isolate, response, "writeStatus", ResponseWriteStatus);
    SetPrototypeMethod(isolate, response, "writeHeader", ResponseWriteHeader);
    SetPrototypeMethod(isolate, response, "cork", ResponseCork);
    SetPrototypeMethod(isolate, response, "write", ResponseWrite);
    SetPrototypeMethod(isolate, response, "tryEnd", ResponseTryEnd);
    SetPrototypeMethod(isolate, response, "onWritable", ResponseOnWritable);
    SetPrototypeMethod(isolate, response, "getWriteOffset", ResponseGetWriteOffset);
    SetPrototypeMethod(
        isolate,
        response,
        "getRemoteAddressAsText",
        ResponseGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, response, "onData", ResponseOnData);
    SetPrototypeMethod(isolate, response, "onAborted", ResponseOnAborted);
    context->responseTemplate.Reset(
        isolate,
        response->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> request = FunctionTemplate::New(isolate);
    request->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, request, "getMethod", RequestGetMethod);
    SetPrototypeMethod(isolate, request, "getUrl", RequestGetUrl);
    SetPrototypeMethod(isolate, request, "getHeader", RequestGetHeader);
    SetPrototypeMethod(isolate, request, "getQuery", RequestGetQuery);
    SetPrototypeMethod(isolate, request, "getParameter", RequestGetParameter);
    SetPrototypeMethod(isolate, request, "forEach", RequestForEach);
    context->requestTemplate.Reset(
        isolate,
        request->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> app = FunctionTemplate::New(isolate);
    app->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, app, "get", AppGet);
    SetPrototypeMethod(isolate, app, "post", AppPost);
    SetPrototypeMethod(isolate, app, "put", AppPut);
    SetPrototypeMethod(isolate, app, "patch", AppPatch);
    SetPrototypeMethod(isolate, app, "del", AppDelete);
    SetPrototypeMethod(isolate, app, "options", AppOptions);
    SetPrototypeMethod(isolate, app, "head", AppHead);
    SetPrototypeMethod(isolate, app, "any", AppAny);
    SetPrototypeMethod(isolate, app, "listen", AppListen);
    SetPrototypeMethod(isolate, app, "close", AppClose);
    context->appConstructor.Reset(
        isolate,
        app->GetFunction(isolate->GetCurrentContext()).ToLocalChecked());

    Local<Function> createApp = FunctionTemplate::New(isolate, CreateApp, contextExternal)
                                    ->GetFunction(isolate->GetCurrentContext())
                                    .ToLocalChecked();
    exports
        ->Set(isolate->GetCurrentContext(), NewString(isolate, "createApp"), createApp)
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(), NewString(isolate, "App"), createApp)
        .ToChecked();
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "version"),
            FunctionTemplate::New(isolate, Version)
                ->GetFunction(isolate->GetCurrentContext())
                .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "us_listen_socket_close"),
            FunctionTemplate::New(isolate, CloseListenSocket, contextExternal)
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
