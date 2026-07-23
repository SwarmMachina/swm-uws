#include <App.h>
#include <node.h>
#include <v8.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::Array;
using v8::Boolean;
using v8::BigInt;
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
using v8::Null;
using v8::Number;
using v8::Object;
using v8::PropertyDescriptor;
using v8::SharedArrayBuffer;
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
    Connect,
    Trace,
    Any,
};

struct PerContextData;

struct ValidatedStringCache {
    bool Matches(Isolate *isolate, Local<String> value) const {
        return !key.IsEmpty() && key.Get(isolate)->StrictEquals(value);
    }

    void Store(Isolate *isolate, Local<String> value) {
        key.Reset(isolate, value);
    }

    Global<String> key;
};

struct AppState {
    std::unique_ptr<uWS::App> app;
    PerContextData *context = nullptr;
    std::vector<us_listen_socket_t *> listenSockets;
    bool closed = false;
    bool hasWebSockets = false;
    std::vector<std::unique_ptr<Global<Function>>> handlers;
};

struct PerContextData {
    Isolate *isolate;
    Global<Object> responseTemplate;
    Global<Object> requestTemplate;
    Global<Object> requestHeadersTemplate;
    Global<Object> socketTemplate;
    Global<Function> appConstructor;
    ValidatedStringCache responseHeaderNameValidation;
    ValidatedStringCache responseHeaderValueValidation;
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

struct ResponseMetadata {
    std::optional<uintmax_t> tryEndTotal;
    bool chunked = false;
};

struct SocketState;

struct PerSocketData {
    SocketState *state = nullptr;
};

using NativeWebSocket = uWS::WebSocket<false, true, PerSocketData>;

struct SocketState {
    Isolate *isolate = nullptr;
    NativeWebSocket *socket = nullptr;
    bool callbackFailed = false;
    Global<Object> object;
    Global<Value> userData;
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

Local<String> NewOneByteString(Isolate *isolate, std::string_view value) {
    if (value.empty()) return String::Empty(isolate);
    return String::NewFromOneByte(
               isolate,
               reinterpret_cast<const uint8_t *>(value.data()),
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

// CallbackScope supplies Node's top-level callback/uncaught-exception boundary,
// while Function::Call keeps the empty MaybeLocal visible to us. The caller owns
// all native cleanup after false; Node/V8 owns delivery of the original error.
[[nodiscard]] bool CallJs(
    Isolate *isolate,
    Local<Function> function,
    int argc,
    Local<Value> *argv) {
    Local<Object> receiver = isolate->GetCurrentContext()->Global();
    node::CallbackScope callbackScope(isolate, receiver, {0, 0});
    v8::TryCatch tryCatch(isolate);
    if (!function
             ->Call(
                 isolate->GetCurrentContext(),
                 receiver,
                 argc,
                 argv)
             .IsEmpty()) {
        return true;
    }
    if (tryCatch.HasCaught()) node::FatalException(isolate, tryCatch);
    return false;
}

[[nodiscard]] bool CallJsValue(
    Isolate *isolate,
    Local<Function> function,
    int argc,
    Local<Value> *argv,
    Local<Value> *result) {
    Local<Object> receiver = isolate->GetCurrentContext()->Global();
    node::CallbackScope callbackScope(isolate, receiver, {0, 0});
    v8::TryCatch tryCatch(isolate);
    if (function
            ->Call(
                isolate->GetCurrentContext(),
                receiver,
                argc,
                argv)
            .ToLocal(result)) {
        return true;
    }
    if (tryCatch.HasCaught()) node::FatalException(isolate, tryCatch);
    return false;
}

[[nodiscard]] bool CallJsDirect(
    Isolate *isolate,
    Local<Function> function,
    int argc,
    Local<Value> *argv,
    Local<Value> *exception) {
    v8::TryCatch tryCatch(isolate);
    if (!function
             ->Call(
                 isolate->GetCurrentContext(),
                 isolate->GetCurrentContext()->Global(),
                 argc,
                 argv)
             .IsEmpty()) {
        return true;
    }
    if (tryCatch.HasCaught()) *exception = tryCatch.Exception();
    return false;
}

// Arena-backed views remain valid while all enclosing NativeBytes instances
// are alive: only the outermost construction resets the thread-local arena and
// nested instances reserve later bytes. Fallback storage belongs to this
// instance. A View() must never outlive its owner. Callers must not enter
// re-entrant JavaScript between acquiring an otherwise unstable view and its
// final native use; copy first when that rule cannot be satisfied.
class NativeBytes {
public:
    NativeBytes(Isolate *isolate, Local<Value> value, bool allowUndefined = false) {
        if (arenaDepth_++ == 0) {
            arenaOffset_ = 0;
        }

        if (allowUndefined && value->IsUndefined()) {
            return;
        }

        if (value->IsString()) {
            Local<String> string = value.As<String>();
#if V8_MAJOR_VERSION >= 13
            const size_t length = string->Utf8LengthV2(isolate);
            char *data = Allocate(length);
            string->WriteUtf8V2(isolate, data, length);
#else
            const int length = string->Utf8Length(isolate);
            char *data = Allocate(static_cast<std::size_t>(length));
            string->WriteUtf8(
                isolate,
                data,
                length,
                nullptr,
                String::NO_NULL_TERMINATION);
#endif
            data_ = data;
            length_ = static_cast<std::size_t>(length);
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

        if (value->IsSharedArrayBuffer()) {
            std::shared_ptr<v8::BackingStore> backing =
                value.As<SharedArrayBuffer>()->GetBackingStore();
            data_ = static_cast<const char *>(backing->Data());
            length_ = backing->ByteLength();
            return;
        }

        valid_ = false;
    }

    ~NativeBytes() {
        arenaDepth_--;
    }

    NativeBytes(const NativeBytes &) = delete;
    NativeBytes &operator=(const NativeBytes &) = delete;

    bool IsValid() const {
        return valid_;
    }

    std::string_view View() const {
        return {data_, length_};
    }

private:
    static constexpr std::size_t ArenaSize = 128 * 1024;
    static constexpr std::size_t ArenaAlignment = 8;
    inline static thread_local std::array<char, ArenaSize> arena_{};
    inline static thread_local std::size_t arenaOffset_ = 0;
    inline static thread_local std::size_t arenaDepth_ = 0;

    char *Allocate(std::size_t length) {
        const std::size_t remaining = arena_.size() - arenaOffset_;
        if (length <= remaining) {
            const std::size_t alignedLength =
                (length + ArenaAlignment - 1) & ~(ArenaAlignment - 1);
            if (alignedLength <= remaining) {
                char *data = arena_.data() + arenaOffset_;
                arenaOffset_ += alignedLength;
                return data;
            }
        }

        fallback_.resize(length);
        return fallback_.data();
    }

    std::string fallback_;
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

bool EqualsAsciiCaseInsensitive(std::string_view left, std::string_view right) {
    if (left.length() != right.length()) return false;
    for (std::size_t index = 0; index < left.length(); index++) {
        unsigned char a = static_cast<unsigned char>(left[index]);
        unsigned char b = static_cast<unsigned char>(right[index]);
        if (a >= 'A' && a <= 'Z') a = static_cast<unsigned char>(a + ('a' - 'A'));
        if (b >= 'A' && b <= 'Z') b = static_cast<unsigned char>(b + ('a' - 'A'));
        if (a != b) return false;
    }
    return true;
}

bool IsBindingManagedFramingHeader(std::string_view name) {
    return EqualsAsciiCaseInsensitive(name, "content-length") ||
        EqualsAsciiCaseInsensitive(name, "transfer-encoding");
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
    auto *metadata = static_cast<ResponseMetadata *>(GetInternalPointer(object, 2));
    if (metadata) {
        SetInternalPointer(object, nullptr, 2);
        delete metadata;
    }
}

ResponseMetadata *GetResponseMetadata(Local<Object> object) {
    auto *metadata = static_cast<ResponseMetadata *>(GetInternalPointer(object, 2));
    if (!metadata) {
        metadata = new ResponseMetadata;
        SetInternalPointer(object, metadata, 2);
    }
    return metadata;
}

void InvalidateAsyncResponse(const std::shared_ptr<AsyncResponseState> &state) {
    if (!state->valid) return;
    Local<Object> object = state->object.Get(state->isolate);
    InvalidateResponseObject(object);
    SetInternalPointer(object, nullptr, 1);
    state->response = nullptr;
    state->valid = false;
    state->dataHandler.Reset();
    state->abortedHandler.Reset();
    state->writableHandler.Reset();
    state->object.Reset();
}

void CloseAsyncResponseAfterCallbackFailure(
    const std::shared_ptr<AsyncResponseState> &state) {
    if (!state->valid) return;
    HttpResponse *response = state->response;
    InvalidateAsyncResponse(state);
    response->close();
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
        if (hasHandler && !CallJs(isolate, handler, 0, nullptr)) return;
    });
    return state;
}

void ResponseEnd(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;

    if (args.Length() > 2) {
        ThrowTypeError(args.GetIsolate(), "res.end(body?, closeConnection?) received too many arguments");
        return;
    }

    NativeBytes body(args.GetIsolate(), args[0], true);
    if (!body.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "res.end(body) expects a string or buffer");
        return;
    }
    const bool closeConnection = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    if (async) {
        std::shared_ptr<AsyncResponseState> asyncState = async->shared_from_this();
        response->end(body.View(), closeConnection);
        InvalidateAsyncResponse(asyncState);
    } else {
        InvalidateResponseObject(args.This());
        response->end(body.View(), closeConnection);
    }
    args.GetReturnValue().Set(args.This());
}

void ResponseEndWithoutBody(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() > 2 ||
        (args.Length() > 0 && !args[0]->IsUndefined() && !args[0]->IsNumber())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.endWithoutBody(reportedContentLength?, closeConnection?) received invalid arguments");
        return;
    }

    std::optional<std::size_t> reportedContentLength;
    if (args.Length() > 0 && !args[0]->IsUndefined()) {
        const double length = args[0]
                                  ->NumberValue(args.GetIsolate()->GetCurrentContext())
                                  .FromMaybe(-1);
        if (!std::isfinite(length) || length < 0 ||
            length > 9007199254740991.0 || std::floor(length) != length) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.endWithoutBody() content length must be a non-negative safe integer");
            return;
        }
        reportedContentLength = static_cast<std::size_t>(length);
    }
    const bool closeConnection = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    if (asyncState) InvalidateAsyncResponse(asyncState);
    else InvalidateResponseObject(args.This());
    response->endWithoutBody(reportedContentLength, closeConnection);
    args.GetReturnValue().Set(args.This());
}

void ResponseClose(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.close() does not accept arguments");
        return;
    }
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    if (asyncState) {
        response->close();
        if (asyncState->valid) InvalidateAsyncResponse(asyncState);
    } else {
        InvalidateResponseObject(args.This());
        response->close();
    }
    args.GetReturnValue().Set(args.This());
}

void ResponseEndBatch(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if ((args.Length() != 2 && args.Length() != 3) || !args[0]->IsString() ||
        !args[1]->IsArray()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.endBatch(status, headerLines, body?) expects a status string and a flat header array");
        return;
    }

    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    NativeBytes status(isolate, args[0]);
    if (!IsValidStatus(status.View())) {
        ThrowTypeError(
            isolate,
            "res.endBatch(status, headerLines, body?) expects a valid status");
        return;
    }

    Local<Array> lines = args[1].As<Array>();
    if ((lines->Length() & 1U) != 0) {
        ThrowTypeError(isolate, "res.endBatch() headerLines must contain name/value pairs");
        return;
    }

    std::vector<std::pair<std::string, std::string>> headers;
    headers.reserve(lines->Length() / 2);
    for (uint32_t index = 0; index < lines->Length(); index += 2) {
        Local<Value> nameValue;
        Local<Value> headerValue;
        if (!lines->Get(context, index).ToLocal(&nameValue) ||
            !lines->Get(context, index + 1).ToLocal(&headerValue)) {
            return;
        }
        if (!nameValue->IsString() || !headerValue->IsString()) {
            ThrowTypeError(isolate, "res.endBatch() headerLines entries must be strings");
            return;
        }

        NativeBytes name(isolate, nameValue);
        NativeBytes value(isolate, headerValue);
        if (!IsValidHeaderName(name.View()) ||
            ContainsInvalidHeaderValueCharacter(value.View())) {
            ThrowTypeError(isolate, "res.endBatch() received an invalid header");
            return;
        }
        if (IsBindingManagedFramingHeader(name.View())) {
            ThrowTypeError(
                isolate,
                "res.endBatch() manages Content-Length and Transfer-Encoding automatically");
            return;
        }
        headers.emplace_back(name.View(), value.View());
    }

    Local<Value> bodyValue = v8::Undefined(isolate);
    if (args.Length() == 3) bodyValue = args[2];
    NativeBytes body(isolate, bodyValue, true);
    if (!body.IsValid()) {
        ThrowTypeError(isolate, "res.endBatch() body expects a string or buffer");
        return;
    }

    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    response->cork([response, &status, &headers, &body]() {
        response->writeStatus(status.View());
        for (const auto &[name, value] : headers) {
            response->writeHeader(name, value);
        }
        response->end(body.View());
    });

    if (asyncState) InvalidateAsyncResponse(asyncState);
    else InvalidateResponseObject(args.This());
    args.GetReturnValue().Set(args.This());
}

void ResponseWriteStatus(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "res.writeStatus(status) expects a string or buffer");
        return;
    }
    NativeBytes status(args.GetIsolate(), args[0]);
    if (!status.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeStatus(status) expects a string or buffer");
        return;
    }
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
    if (args.Length() != 2) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader(name, value) expects strings or buffers");
        return;
    }
    NativeBytes name(args.GetIsolate(), args[0]);
    NativeBytes value(args.GetIsolate(), args[1]);
    if (!name.IsValid() || !value.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader(name, value) expects strings or buffers");
        return;
    }
    auto *context = static_cast<PerContextData *>(args.Data().As<External>()->Value());
    const bool cachedName = args[0]->IsString() &&
        context->responseHeaderNameValidation.Matches(
            args.GetIsolate(),
            args[0].As<String>());
    if (!cachedName) {
        if (!IsValidHeaderName(name.View())) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.writeHeader(name, value) expects a valid HTTP header name");
            return;
        }
        if (args[0]->IsString()) {
            context->responseHeaderNameValidation.Store(
                args.GetIsolate(),
                args[0].As<String>());
        }
    }
    if (IsBindingManagedFramingHeader(name.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader() manages Content-Length and Transfer-Encoding automatically");
        return;
    }
    const bool cachedValue = args[1]->IsString() &&
        context->responseHeaderValueValidation.Matches(
            args.GetIsolate(),
            args[1].As<String>());
    if (!cachedValue) {
        if (ContainsInvalidHeaderValueCharacter(value.View())) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.writeHeader(name, value) does not allow control characters in value");
            return;
        }
        if (args[1]->IsString()) {
            context->responseHeaderValueValidation.Store(
                args.GetIsolate(),
                args[1].As<String>());
        }
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
    bool callbackSucceeded = true;
    Local<Value> callbackException;
    HttpResponse *updated = response->cork([isolate, handler, &callbackSucceeded, &callbackException]() {
        callbackSucceeded =
            CallJsDirect(isolate, handler, 0, nullptr, &callbackException);
    });
    if (!callbackSucceeded) {
        if (GetInternalPointer(args.This())) {
            auto *async = static_cast<AsyncResponseState *>(
                GetInternalPointer(args.This(), 1));
            if (async) {
                CloseAsyncResponseAfterCallbackFailure(async->shared_from_this());
            } else {
                InvalidateResponseObject(args.This());
                updated->close();
            }
        }
        if (!callbackException.IsEmpty()) isolate->ThrowException(callbackException);
        return;
    }
    if (GetInternalPointer(args.This())) SetInternalPointer(args.This(), updated);
    args.GetReturnValue().Set(args.This());
}

void ResponseBeginWrite(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.beginWrite() does not accept arguments");
        return;
    }
    response->beginWrite();
    GetResponseMetadata(args.This())->chunked = true;
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
    GetResponseMetadata(args.This())->chunked = true;
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
    ResponseMetadata *metadata = GetResponseMetadata(args.This());
    const uintmax_t totalSize = totalNumber == 0
        ? static_cast<uintmax_t>(chunk.View().size())
        : static_cast<uintmax_t>(totalNumber);
    if (!metadata->chunked) {
        const uintmax_t offset = response->getWriteOffset();
        if ((metadata->tryEndTotal && *metadata->tryEndTotal != totalSize) ||
            offset > totalSize ||
            chunk.View().size() > totalSize - offset) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.tryEnd() chunk exceeds or conflicts with the declared total size");
            return;
        }
        metadata->tryEndTotal = totalSize;
    }

    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    const auto [ok, done] = response->tryEnd(
        chunk.View(),
        totalSize);
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
        Local<Value> result;
        if (!CallJsValue(
                isolate,
                state->writableHandler.Get(isolate),
                1,
                argv,
                &result)) {
            CloseAsyncResponseAfterCallbackFailure(state);
            return false;
        }
        return result->BooleanValue(isolate);
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

Local<ArrayBuffer> ExternalArrayBuffer(Isolate *isolate, std::string_view value) {
    std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
        const_cast<char *>(value.data()),
        value.length(),
        [](void *, size_t, void *) {},
        nullptr);
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

void ResponseGetRemoteAddress(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.getRemoteAddress() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), response->getRemoteAddress()));
}

void ResponseGetRemotePort(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.getRemotePort() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), response->getRemotePort()));
}

void ResponseGetProxiedRemoteAddress(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.getProxiedRemoteAddress() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), response->getProxiedRemoteAddress()));
}

void ResponseGetProxiedRemoteAddressAsText(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.getProxiedRemoteAddressAsText() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(CopyToArrayBuffer(
        args.GetIsolate(),
        response->getProxiedRemoteAddressAsText()));
}

void ResponseGetProxiedRemotePort(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.getProxiedRemotePort() does not accept arguments");
        return;
    }
    // The vendored ProxyParser stores the two network-order bytes verbatim.
    uint16_t networkPort = static_cast<uint16_t>(response->getProxiedRemotePort());
    const auto *bytes = reinterpret_cast<const uint8_t *>(&networkPort);
    uint16_t hostPort = static_cast<uint16_t>((bytes[0] << 8) | bytes[1]);
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), hostPort));
}

void ResponseUpgrade(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 5 || !args[4]->IsExternal()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.upgrade(userData, key, protocol, extensions, context) received invalid arguments");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    NativeBytes key(isolate, args[1]);
    NativeBytes protocol(isolate, args[2]);
    NativeBytes extensions(isolate, args[3]);
    if (!key.IsValid() || !protocol.IsValid() || !extensions.IsValid()) {
        ThrowTypeError(
            isolate,
            "res.upgrade() key, protocol and extensions expect strings or buffers");
        return;
    }
    auto *socketState = new SocketState;
    socketState->isolate = isolate;
    socketState->userData.Reset(isolate, args[0]);
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState = async
        ? async->shared_from_this()
        : std::shared_ptr<AsyncResponseState>();
    response->upgrade<PerSocketData>(
        PerSocketData{socketState},
        key.View(),
        protocol.View(),
        extensions.View(),
        static_cast<us_socket_context_t *>(args[4].As<External>()->Value()));
    if (asyncState) InvalidateAsyncResponse(asyncState);
    else InvalidateResponseObject(args.This());
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
        const bool callbackSucceeded =
            CallJs(isolate, state->dataHandler.Get(isolate), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
    });
    args.GetReturnValue().Set(args.This());
}

void ResponseOnDataV2(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "res.onDataV2(handler) expects a function");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->dataHandlerRegistered) {
        ThrowError(args.GetIsolate(), "res.onDataV2() body handler is already registered");
        return;
    }
    state->dataHandlerRegistered = true;
    state->dataHandler.Reset(args.GetIsolate(), args[0].As<Function>());
    state->response->onDataV2(
        [state](std::string_view chunk, uint64_t maxRemainingBodyLength) {
            if (!state->valid || state->dataHandler.IsEmpty()) return;
            Isolate *isolate = state->isolate;
            HandleScope scope(isolate);
            Local<ArrayBuffer> buffer = ExternalArrayBuffer(isolate, chunk);
            Local<Value> argv[] = {
                buffer,
                BigInt::NewFromUnsigned(isolate, maxRemainingBodyLength)};
            const bool callbackSucceeded =
                CallJs(isolate, state->dataHandler.Get(isolate), 2, argv);
            buffer->Detach(Local<Value>()).FromMaybe(false);
            if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
        });
    args.GetReturnValue().Set(args.This());
}

void ResponseCollectBody(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 2 || !args[0]->IsNumber() || !args[1]->IsFunction()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.collectBody(maxSize, handler) expects a size and a function");
        return;
    }

    Isolate *isolate = args.GetIsolate();
    const double maxSizeNumber = args[0]->NumberValue(isolate->GetCurrentContext())
                                     .FromMaybe(-1);
    constexpr double MaxCollectBodySize = 1024.0 * 1024.0 * 1024.0;
    if (!std::isfinite(maxSizeNumber) || maxSizeNumber < 0 ||
        maxSizeNumber > MaxCollectBodySize || std::floor(maxSizeNumber) != maxSizeNumber) {
        ThrowTypeError(
            isolate,
            "res.collectBody(maxSize, handler) maxSize must be an integer between 0 and 1 GiB");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->dataHandlerRegistered) {
        ThrowError(args.GetIsolate(), "res.collectBody() body handler is already registered");
        return;
    }
    state->dataHandlerRegistered = true;
    state->dataHandler.Reset(isolate, args[1].As<Function>());

    struct Collection {
        std::vector<char> bytes;
        bool completed = false;
    };
    auto collection = std::make_shared<Collection>();
    const std::size_t maxSize = static_cast<std::size_t>(maxSizeNumber);

    state->response->onDataV2(
        [state, collection, maxSize](std::string_view chunk, uint64_t maxRemainingBodyLength) {
            if (!state->valid || state->dataHandler.IsEmpty() || collection->completed) {
                return;
            }

            Isolate *callbackIsolate = state->isolate;
            HandleScope scope(callbackIsolate);
            if (collection->bytes.size() > maxSize ||
                chunk.size() > maxSize - collection->bytes.size()) {
                collection->completed = true;
                Local<Value> argv[] = {Null(callbackIsolate)};
                const bool callbackSucceeded = CallJs(
                    callbackIsolate,
                    state->dataHandler.Get(callbackIsolate),
                    1,
                    argv);
                state->dataHandler.Reset();
                if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
                return;
            }

            if (collection->bytes.empty() &&
                maxRemainingBodyLength <= maxSize - chunk.size()) {
                collection->bytes.reserve(
                    chunk.size() + static_cast<std::size_t>(maxRemainingBodyLength));
            }
            collection->bytes.insert(
                collection->bytes.end(),
                chunk.begin(),
                chunk.end());
            if (maxRemainingBodyLength != 0) return;

            collection->completed = true;
            auto *owned = new std::vector<char>(std::move(collection->bytes));
            if (owned->empty()) {
                delete owned;
                Local<ArrayBuffer> body = ArrayBuffer::New(callbackIsolate, 0);
                Local<Value> argv[] = {body};
                const bool callbackSucceeded = CallJs(
                    callbackIsolate,
                    state->dataHandler.Get(callbackIsolate),
                    1,
                    argv);
                state->dataHandler.Reset();
                if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
                return;
            }
            std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
                owned->data(),
                owned->size(),
                [](void *, size_t, void *deleterData) {
                    delete static_cast<std::vector<char> *>(deleterData);
                },
                owned);
            Local<ArrayBuffer> body = ArrayBuffer::New(callbackIsolate, std::move(backing));
            Local<Value> argv[] = {body};
            const bool callbackSucceeded = CallJs(
                callbackIsolate,
                state->dataHandler.Get(callbackIsolate),
                1,
                argv);
            state->dataHandler.Reset();
            if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
        });
    args.GetReturnValue().Set(args.This());
}

void ResponsePause(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.pause() does not accept arguments");
        return;
    }
    response->pause();
    args.GetReturnValue().Set(args.This());
}

void ResponseResume(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.resume() does not accept arguments");
        return;
    }
    response->resume();
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
    std::string method(request->getCaseSensitiveMethod());
    for (char &character : method) {
        if (character >= 'A' && character <= 'Z') character |= 32;
    }
    args.GetReturnValue().Set(NewString(args.GetIsolate(), method));
}

void RequestGetCaseSensitiveMethod(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "req.getCaseSensitiveMethod() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        NewString(args.GetIsolate(), request->getCaseSensitiveMethod()));
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
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "req.getHeader(name) expects a string or buffer");
        return;
    }
    NativeBytes nativeName(args.GetIsolate(), args[0]);
    if (!nativeName.IsValid() || !IsValidHeaderName(nativeName.View())) {
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
    args.GetReturnValue().Set(
        NewOneByteString(args.GetIsolate(), request->getHeader(name)));
}

void RequestGetQuery(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() == 0) {
        args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getQuery()));
        return;
    }
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "req.getQuery(key) expects a string or buffer");
        return;
    }
    NativeBytes key(args.GetIsolate(), args[0]);
    if (!key.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "req.getQuery(key) expects a string or buffer");
        return;
    }
    std::string_view value = request->getQuery(key.View());
    if (value.data()) args.GetReturnValue().Set(NewString(args.GetIsolate(), value));
}

void RequestGetParameter(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "req.getParameter(indexOrName) expects a number or string");
        return;
    }
    if (!args[0]->IsNumber()) {
        NativeBytes name(args.GetIsolate(), args[0]);
        if (!name.IsValid()) {
            ThrowTypeError(
                args.GetIsolate(),
                "req.getParameter(indexOrName) expects a number, string, or buffer");
            return;
        }
        std::string_view value = request->getParameter(name.View());
        if (value.data()) args.GetReturnValue().Set(NewString(args.GetIsolate(), value));
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

void RequestSetYield(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "req.setYield(value) expects one argument");
        return;
    }
    request->setYield(args[0]->BooleanValue(args.GetIsolate()));
    args.GetReturnValue().Set(args.This());
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
        Local<Value> exception;
        if (!CallJsDirect(isolate, handler, 2, argv, &exception)) {
            if (!exception.IsEmpty()) isolate->ThrowException(exception);
            return;
        }
    }
}

void RequestSnapshot(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() > 1 || (args.Length() == 1 && !args[0]->IsNumber())) {
        ThrowTypeError(args.GetIsolate(), "req.snapshot(paramCount?) expects an optional number");
        return;
    }

    unsigned int paramCount = 0;
    if (args.Length() == 1) {
        const double count = args[0]->NumberValue(args.GetIsolate()->GetCurrentContext())
                                 .FromMaybe(-1);
        if (!std::isfinite(count) || count < 0 || count > 65535 ||
            std::floor(count) != count) {
            ThrowTypeError(args.GetIsolate(), "req.snapshot() paramCount must be a valid integer");
            return;
        }
        paramCount = static_cast<unsigned int>(count);
    }

    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Object> snapshot = Object::New(isolate);
    auto *contextData = static_cast<PerContextData *>(
        args.Data().As<External>()->Value());
    Local<Object> headers = contextData->requestHeadersTemplate.Get(isolate)->Clone();

    for (const auto &[name, value] : *request) {
        if (!headers
                 ->CreateDataProperty(
                     context,
                     NewString(isolate, name),
                     NewString(isolate, value))
                 .FromMaybe(false)) {
            return;
        }
    }

    Local<Array> params = Array::New(isolate, static_cast<int>(paramCount));
    for (unsigned int index = 0; index < paramCount; index++) {
        std::string_view value = request->getParameter(static_cast<unsigned short>(index));
        if (value.data() &&
            !params
                 ->Set(context, index, NewString(isolate, value))
                 .FromMaybe(false)) {
            return;
        }
    }

    if (!snapshot
             ->CreateDataProperty(
                 context,
                 NewString(isolate, "method"),
                 NewString(isolate, request->getMethod()))
             .FromMaybe(false) ||
        !snapshot
             ->CreateDataProperty(
                 context,
                 NewString(isolate, "url"),
                 NewString(isolate, request->getUrl()))
             .FromMaybe(false) ||
        !snapshot
             ->CreateDataProperty(
                 context,
                 NewString(isolate, "query"),
                 NewString(isolate, request->getQuery()))
             .FromMaybe(false) ||
        !snapshot
             ->CreateDataProperty(context, NewString(isolate, "headers"), headers)
             .FromMaybe(false) ||
        !snapshot
             ->CreateDataProperty(context, NewString(isolate, "params"), params)
             .FromMaybe(false)) {
        return;
    }

    args.GetReturnValue().Set(snapshot);
}

SocketState *GetSocketState(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<SocketState *>(GetInternalPointer(args.This()));
    if (!state || !state->socket) {
        ThrowError(args.GetIsolate(), "WebSocket is no longer valid");
        return nullptr;
    }
    return state;
}

void FailSocketCallback(SocketState *state) {
    state->callbackFailed = true;
    if (!state->socket) return;
    NativeWebSocket *socket = state->socket;
    state->socket = nullptr;
    if (!state->object.IsEmpty()) {
        SetInternalPointer(state->object.Get(state->isolate), nullptr);
    }
    socket->close();
}

void FailSocketCallback(NativeWebSocket *socket, Local<Object> object) {
    auto *state = static_cast<SocketState *>(GetInternalPointer(object));
    if (state) {
        FailSocketCallback(state);
        return;
    }
    state = socket->getUserData()->state;
    if (state) state->callbackFailed = true;
}

void SocketSend(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 3 ||
        (args.Length() > 1 && !args[1]->IsBoolean()) ||
        (args.Length() > 2 && !args[2]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.send(message, isBinary, compress) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.send(message) expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(state->socket->send(
        message.View(),
        isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
        compress)));
}

void SocketSendFirstFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 3 ||
        (args.Length() > 1 && !args[1]->IsBoolean()) ||
        (args.Length() > 2 && !args[2]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendFirstFragment(message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (!message.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendFirstFragment(message) expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 2 &&
        args[2]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(state->socket->sendFirstFragment(
        message.View(),
        isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
        compress)));
}

void SocketSendFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 2 ||
        (args.Length() > 1 && !args[1]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendFragment(message, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.sendFragment(message) expects a string or buffer");
        return;
    }
    const bool compress = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(
        state->socket->sendFragment(message.View(), compress)));
}

void SocketSendLastFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 2 ||
        (args.Length() > 1 && !args[1]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendLastFragment(message, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (!message.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendLastFragment(message) expects a string or buffer");
        return;
    }
    const bool compress = args.Length() > 1 &&
        args[1]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(
        state->socket->sendLastFragment(message.View(), compress)));
}

void SocketPing(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() > 1) {
        ThrowTypeError(args.GetIsolate(), "ws.ping(message?) received too many arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0], true);
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.ping(message?) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(static_cast<int>(
        state->socket->send(message.View(), uWS::OpCode::PING)));
}

void SocketPublish(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 2 || args.Length() > 4 ||
        (args.Length() > 2 && !args[2]->IsBoolean()) ||
        (args.Length() > 3 && !args[3]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.publish(topic, message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    NativeBytes message(args.GetIsolate(), args[1]);
    if (!topic.IsValid() || !message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.publish() message expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 2 &&
        args[2]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 3 &&
        args[3]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->socket->publish(
            topic.View(),
            message.View(),
            isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
            compress)));
}

void SocketCork(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(args.GetIsolate(), "ws.cork(handler) expects a function");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Function> handler = args[0].As<Function>();
    bool callbackSucceeded = true;
    Local<Value> callbackException;
    NativeWebSocket *socket = state->socket;
    socket->cork([isolate, handler, &callbackSucceeded, &callbackException]() {
        callbackSucceeded =
            CallJsDirect(isolate, handler, 0, nullptr, &callbackException);
    });
    if (!callbackSucceeded) {
        FailSocketCallback(socket, args.This());
        if (!callbackException.IsEmpty()) isolate->ThrowException(callbackException);
        return;
    }
    args.GetReturnValue().Set(args.This());
}

void SocketIsSubscribed(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "ws.isSubscribed(topic) expects a string or buffer");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.isSubscribed(topic) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->socket->isSubscribed(topic.View())));
}

void SocketGetTopics(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getTopics() does not accept arguments");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Array> topics = Array::New(isolate);
    state->socket->iterateTopics([isolate, topics](std::string_view topic) {
        topics
            ->Set(
                isolate->GetCurrentContext(),
                topics->Length(),
                NewString(isolate, topic))
            .ToChecked();
    });
    args.GetReturnValue().Set(topics);
}

void SocketGetRemoteAddress(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getRemoteAddress() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), state->socket->getRemoteAddress()));
}

void SocketGetRemoteAddressAsText(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.getRemoteAddressAsText() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), state->socket->getRemoteAddressAsText()));
}

void SocketGetRemotePort(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getRemotePort() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        Number::New(args.GetIsolate(), state->socket->getRemotePort()));
}

bool IsValidWebSocketCloseCode(int code) {
    if (code == 0) return true;
    if (code < 1000 || code > 4999) return false;
    return code != 1004 && code != 1005 && code != 1006 && code != 1015;
}

void SocketEnd(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() > 2 ||
        (args.Length() > 0 && !args[0]->IsUndefined() && !args[0]->IsNumber())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.end([code[, reason]]) expects a number and a string");
        return;
    }
    int code = 0;
    if (args.Length() > 0 && args[0]->IsNumber()) {
        const double numericCode = args[0]
                                       ->NumberValue(args.GetIsolate()->GetCurrentContext())
                                       .FromMaybe(-1);
        if (!std::isfinite(numericCode) || std::floor(numericCode) != numericCode) {
            ThrowTypeError(args.GetIsolate(), "ws.end() code must be an integer");
            return;
        }
        if (numericCode < 0 || numericCode > 4999) {
            ThrowTypeError(
                args.GetIsolate(),
                "ws.end() code must be 0 or a valid WebSocket close code");
            return;
        }
        code = static_cast<int>(numericCode);
    }
    if (!IsValidWebSocketCloseCode(code)) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.end() code must be 0 or a valid WebSocket close code");
        return;
    }
    Local<Value> reasonValue = String::Empty(args.GetIsolate());
    if (args.Length() > 1) reasonValue = args[1];
    NativeBytes reason(args.GetIsolate(), reasonValue);
    if (!reason.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.end([code[, reason]]) reason expects a string or buffer");
        return;
    }
    if (code == 0 && !reason.View().empty()) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.end() reason requires a non-zero close code");
        return;
    }
    if (reason.View().length() > 123) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.end() reason must be at most 123 UTF-8 bytes");
        return;
    }
    NativeWebSocket *socket = state->socket;
    SetInternalPointer(args.This(), nullptr);
    state->socket = nullptr;
    socket->end(code, reason.View());
}

void SocketClose(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.close() does not accept arguments");
        return;
    }
    NativeWebSocket *socket = state->socket;
    SetInternalPointer(args.This(), nullptr);
    state->socket = nullptr;
    socket->close();
}

void SocketGetBufferedAmount(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getBufferedAmount() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(Number::New(
        args.GetIsolate(),
        static_cast<double>(state->socket->getBufferedAmount())));
}

void SocketGetUserData(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getUserData() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(args.This());
}

void SocketSubscribe(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "ws.subscribe(topic) expects a string or buffer");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.subscribe(topic) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->socket->subscribe(topic.View())));
}

void SocketUnsubscribe(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "ws.unsubscribe(topic) expects a string or buffer");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.unsubscribe(topic) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->socket->unsubscribe(topic.View())));
}

void RegisterHttpRoute(
    const FunctionCallbackInfo<Value> &args,
    HttpMethod method,
    const char *methodName) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 2 || !args[1]->IsFunction()) {
        std::string message = "app." + std::string(methodName) +
            "(path, handler) expects a string and a function";
        ThrowTypeError(isolate, message.c_str());
        return;
    }

    NativeBytes path(isolate, args[0]);
    if (!path.IsValid()) {
        ThrowTypeError(isolate, "app route path expects a string or buffer");
        return;
    }
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
        SetInternalPointer(requestObject, request);
        Local<Value> argv[] = {responseObject, requestObject};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        SetInternalPointer(requestObject, nullptr);

        if (GetInternalPointer(responseObject)) {
            auto *async = static_cast<AsyncResponseState *>(
                GetInternalPointer(responseObject, 1));
            if (!callbackSucceeded && async) {
                CloseAsyncResponseAfterCallbackFailure(async->shared_from_this());
            } else if (!async) {
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
        case HttpMethod::Connect:
            state->app->connect(pathString, std::move(routeHandler));
            break;
        case HttpMethod::Trace:
            state->app->trace(pathString, std::move(routeHandler));
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
void AppConnect(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Connect, "connect");
}
void AppTrace(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Trace, "trace");
}
void AppAny(const FunctionCallbackInfo<Value> &args) {
    RegisterHttpRoute(args, HttpMethod::Any, "any");
}

[[nodiscard]] bool GetProperty(
    Isolate *isolate,
    Local<Object> object,
    const char *name,
    Local<Value> *result) {
    return object->Get(isolate->GetCurrentContext(), NewString(isolate, name))
        .ToLocal(result);
}

bool ReadUnsignedOption(
    Isolate *isolate,
    Local<Object> options,
    const char *name,
    unsigned int minimum,
    unsigned int maximum,
    unsigned int *target) {
    Local<Value> value;
    if (!GetProperty(isolate, options, name, &value)) return false;
    if (value->IsUndefined()) return true;
    if (!value->IsNumber()) {
        std::string message = "WebSocket " + std::string(name) + " must be a number";
        ThrowTypeError(isolate, message.c_str());
        return false;
    }
    const double number = value->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
    if (!std::isfinite(number) || std::floor(number) != number || number < minimum ||
        number > maximum) {
        std::string message = "WebSocket " + std::string(name) +
            " must be an integer between " + std::to_string(minimum) + " and " +
            std::to_string(maximum);
        ThrowTypeError(isolate, message.c_str());
        return false;
    }
    *target = static_cast<unsigned int>(number);
    return true;
}

bool ReadBooleanOption(
    Isolate *isolate,
    Local<Object> options,
    const char *name,
    bool *target) {
    Local<Value> value;
    if (!GetProperty(isolate, options, name, &value)) return false;
    if (value->IsUndefined()) return true;
    if (!value->IsBoolean()) {
        std::string message = "WebSocket " + std::string(name) + " must be a boolean";
        ThrowTypeError(isolate, message.c_str());
        return false;
    }
    *target = value->BooleanValue(isolate);
    return true;
}

Global<Function> *StoreOptionalHandler(
    Isolate *isolate,
    Local<Object> options,
    const char *name,
    bool *valid,
    std::vector<std::unique_ptr<Global<Function>>> *pendingHandlers) {
    Local<Value> value;
    if (!GetProperty(isolate, options, name, &value)) {
        *valid = false;
        return nullptr;
    }
    if (value->IsUndefined()) return nullptr;
    if (!value->IsFunction()) {
        ThrowTypeError(isolate, "WebSocket handlers must be functions");
        *valid = false;
        return nullptr;
    }
    auto handler = std::make_unique<Global<Function>>(isolate, value.As<Function>());
    Global<Function> *pointer = handler.get();
    pendingHandlers->push_back(std::move(handler));
    return pointer;
}

[[nodiscard]] bool ReadOwnDescriptorField(
    Local<Context> currentContext,
    Local<Object> descriptor,
    const char *name,
    bool *present,
    Local<Value> *value) {
    Isolate *isolate = currentContext->GetIsolate();
    Local<String> key = NewString(isolate, name);
    v8::Maybe<bool> has = descriptor->HasOwnProperty(currentContext, key);
    if (has.IsNothing()) return false;
    *present = has.FromJust();
    if (!*present) return true;
    return descriptor->Get(currentContext, key).ToLocal(value);
}

[[nodiscard]] bool CopyOwnPropertyDescriptor(
    Local<Context> currentContext,
    Local<Object> source,
    Local<Object> target,
    Local<v8::Name> key) {
    Local<Value> descriptorValue;
    if (!source->GetOwnPropertyDescriptor(currentContext, key).ToLocal(&descriptorValue)) {
        return false;
    }
    if (!descriptorValue->IsObject()) return true;

    Local<Object> descriptorObject = descriptorValue.As<Object>();
    bool hasValue = false;
    bool hasWritable = false;
    bool hasGetter = false;
    bool hasSetter = false;
    bool hasEnumerable = false;
    bool hasConfigurable = false;
    Local<Value> value;
    Local<Value> writable;
    Local<Value> getter;
    Local<Value> setter;
    Local<Value> enumerable;
    Local<Value> configurable;
    if (!ReadOwnDescriptorField(
            currentContext, descriptorObject, "value", &hasValue, &value) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "writable", &hasWritable, &writable) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "get", &hasGetter, &getter) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "set", &hasSetter, &setter) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "enumerable", &hasEnumerable, &enumerable) ||
        !ReadOwnDescriptorField(
            currentContext,
            descriptorObject,
            "configurable",
            &hasConfigurable,
            &configurable)) {
        return false;
    }

    std::unique_ptr<PropertyDescriptor> descriptor;
    if (hasValue) {
        descriptor = std::make_unique<PropertyDescriptor>(
            value,
            hasWritable && writable->BooleanValue(currentContext->GetIsolate()));
    } else {
        Local<Value> getterValue = v8::Undefined(currentContext->GetIsolate());
        Local<Value> setterValue = v8::Undefined(currentContext->GetIsolate());
        if (hasGetter) getterValue = getter;
        if (hasSetter) setterValue = setter;
        descriptor = std::make_unique<PropertyDescriptor>(
            getterValue,
            setterValue);
    }
    if (hasEnumerable) {
        descriptor->set_enumerable(enumerable->BooleanValue(currentContext->GetIsolate()));
    }
    if (hasConfigurable) {
        descriptor->set_configurable(
            configurable->BooleanValue(currentContext->GetIsolate()));
    }
    return target->DefineProperty(currentContext, key, *descriptor).FromMaybe(false);
}

v8::MaybeLocal<Object> EnsureSocketObject(
    PerContextData *context,
    NativeWebSocket *socket) {
    Isolate *isolate = context->isolate;
    SocketState *state = socket->getUserData()->state;
    if (!state) {
        state = new SocketState;
        state->isolate = isolate;
        socket->getUserData()->state = state;
    }
    state->socket = socket;
    if (state->object.IsEmpty()) {
        Local<Object> object = context->socketTemplate.Get(isolate)->Clone();
        if (!state->userData.IsEmpty()) {
            Local<Value> userData = state->userData.Get(isolate);
            if (userData->IsObject()) {
                Local<Object> source = userData.As<Object>();
                Local<Context> currentContext = isolate->GetCurrentContext();
                Local<Array> keys;
                if (!source
                         ->GetOwnPropertyNames(
                             currentContext,
                             v8::ALL_PROPERTIES,
                             v8::KeyConversionMode::kConvertToString)
                         .ToLocal(&keys)) {
                    return {};
                }
                for (uint32_t index = 0; index < keys->Length(); index++) {
                    Local<Value> keyValue;
                    if (!keys->Get(currentContext, index).ToLocal(&keyValue) ||
                        !keyValue->IsName()) {
                        return {};
                    }
                    Local<v8::Name> key = keyValue.As<v8::Name>();
                    v8::Maybe<bool> bindingOwnsKey = object->Has(currentContext, key);
                    if (bindingOwnsKey.IsNothing()) return {};
                    if (bindingOwnsKey.FromJust()) continue;
                    if (!CopyOwnPropertyDescriptor(
                            currentContext,
                            source,
                            object,
                            key)) {
                        return {};
                    }
                }
            }
            state->userData.Reset();
        }
        SetInternalPointer(object, state);
        state->object.Reset(isolate, object);
        return object;
    }
    return state->object.Get(isolate);
}

void AppWs(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 2 || !args[1]->IsObject()) {
        ThrowTypeError(isolate, "app.ws(path, behavior) expects a string and an object");
        return;
    }
    Local<Object> options = args[1].As<Object>();
    uWS::App::WebSocketBehavior<PerSocketData> behavior;
    Local<Value> compression;
    if (!GetProperty(isolate, options, "compression", &compression)) return;
    if (!compression->IsUndefined() &&
        (!compression->IsNumber() ||
         !compression->StrictEquals(Number::New(isolate, uWS::DISABLED)))) {
        ThrowTypeError(
            isolate,
            "WebSocket compression is disabled; only uWS.DISABLED is supported");
        return;
    }
    unsigned int idleTimeout = behavior.idleTimeout;
    unsigned int maxLifetime = behavior.maxLifetime;
    if (!ReadUnsignedOption(
            isolate,
            options,
            "maxPayloadLength",
            1,
            std::numeric_limits<unsigned int>::max(),
            &behavior.maxPayloadLength) ||
        !ReadUnsignedOption(
            isolate,
            options,
            "idleTimeout",
            0,
            960,
            &idleTimeout) ||
        !ReadUnsignedOption(
            isolate,
            options,
            "maxBackpressure",
            0,
            std::numeric_limits<unsigned int>::max(),
            &behavior.maxBackpressure) ||
        !ReadUnsignedOption(
            isolate,
            options,
            "maxLifetime",
            0,
            240,
            &maxLifetime) ||
        !ReadBooleanOption(
            isolate,
            options,
            "closeOnBackpressureLimit",
            &behavior.closeOnBackpressureLimit) ||
        !ReadBooleanOption(
            isolate,
            options,
            "resetIdleTimeoutOnSend",
            &behavior.resetIdleTimeoutOnSend) ||
        !ReadBooleanOption(
            isolate,
            options,
            "sendPingsAutomatically",
            &behavior.sendPingsAutomatically)) {
        return;
    }
    if (idleTimeout > 0 && idleTimeout < 8) {
        ThrowTypeError(isolate, "WebSocket idleTimeout must be 0 or between 8 and 960");
        return;
    }
    behavior.idleTimeout = static_cast<unsigned short>(idleTimeout);
    behavior.maxLifetime = static_cast<unsigned short>(maxLifetime);

    bool handlersValid = true;
    std::vector<std::unique_ptr<Global<Function>>> pendingHandlers;
    Global<Function> *upgrade = StoreOptionalHandler(
        isolate, options, "upgrade", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *open = StoreOptionalHandler(
        isolate, options, "open", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *message = StoreOptionalHandler(
        isolate, options, "message", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *dropped = StoreOptionalHandler(
        isolate, options, "dropped", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *drain = StoreOptionalHandler(
        isolate, options, "drain", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *ping = StoreOptionalHandler(
        isolate, options, "ping", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *pong = StoreOptionalHandler(
        isolate, options, "pong", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *subscription = StoreOptionalHandler(
        isolate, options, "subscription", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *close = StoreOptionalHandler(
        isolate, options, "close", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    for (auto &handler : pendingHandlers) {
        state->handlers.push_back(std::move(handler));
    }

    PerContextData *context = state->context;
    if (upgrade) {
        behavior.upgrade = [context, upgrade](
                               HttpResponse *response,
                               uWS::HttpRequest *request,
                               us_socket_context_t *socketContext) {
            Isolate *callbackIsolate = context->isolate;
            HandleScope scope(callbackIsolate);
            Local<Object> responseObject = context->responseTemplate.Get(callbackIsolate)->Clone();
            Local<Object> requestObject = context->requestTemplate.Get(callbackIsolate)->Clone();
            SetInternalPointer(responseObject, response, 0);
            SetInternalPointer(requestObject, request);
            Local<Value> argv[] = {
                responseObject,
                requestObject,
                External::New(callbackIsolate, socketContext)};
            const bool callbackSucceeded =
                CallJs(callbackIsolate, upgrade->Get(callbackIsolate), 3, argv);
            SetInternalPointer(requestObject, nullptr);
            if (GetInternalPointer(responseObject) &&
                !GetInternalPointer(responseObject, 1)) {
                response->close();
                InvalidateResponseObject(responseObject);
            } else if (!callbackSucceeded && GetInternalPointer(responseObject, 1)) {
                auto *async = static_cast<AsyncResponseState *>(
                    GetInternalPointer(responseObject, 1));
                CloseAsyncResponseAfterCallbackFailure(async->shared_from_this());
            }
        };
    }
    behavior.open = [context, open](NativeWebSocket *socket) {
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        if (open) {
            Local<Value> argv[] = {socketObject};
            if (!CallJs(callbackIsolate, open->Get(callbackIsolate), 1, argv)) {
                FailSocketCallback(socket, socketObject);
            }
        }
    };
    behavior.message = [context, message](
                           NativeWebSocket *socket,
                           std::string_view payload,
                           uWS::OpCode opcode) {
        if (!message) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(callbackIsolate, payload);
        Local<Value> argv[] = {
            socketObject,
            buffer,
            Boolean::New(callbackIsolate, opcode == uWS::OpCode::BINARY)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, message->Get(callbackIsolate), 3, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.dropped = [context, dropped](
                           NativeWebSocket *socket,
                           std::string_view payload,
                           uWS::OpCode opcode) {
        if (!dropped) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(callbackIsolate, payload);
        Local<Value> argv[] = {
            socketObject,
            buffer,
            Boolean::New(callbackIsolate, opcode == uWS::OpCode::BINARY)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, dropped->Get(callbackIsolate), 3, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.drain = [context, drain](NativeWebSocket *socket) {
        if (!drain) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<Value> argv[] = {socketObject};
        if (!CallJs(callbackIsolate, drain->Get(callbackIsolate), 1, argv)) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.ping = [context, ping](NativeWebSocket *socket, std::string_view payload) {
        if (!ping) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(callbackIsolate, payload);
        Local<Value> argv[] = {socketObject, buffer};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, ping->Get(callbackIsolate), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.pong = [context, pong](NativeWebSocket *socket, std::string_view payload) {
        if (!pong) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(callbackIsolate, payload);
        Local<Value> argv[] = {socketObject, buffer};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, pong->Get(callbackIsolate), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.subscription = [context, subscription](
                                NativeWebSocket *socket,
                                std::string_view topic,
                                int newCount,
                                int oldCount) {
        if (!subscription) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, socket).ToLocal(&socketObject)) {
            FailSocketCallback(socket->getUserData()->state);
            return;
        }
        Local<ArrayBuffer> topicBuffer = ExternalArrayBuffer(callbackIsolate, topic);
        Local<Value> argv[] = {
            socketObject,
            topicBuffer,
            Number::New(callbackIsolate, newCount),
            Number::New(callbackIsolate, oldCount)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, subscription->Get(callbackIsolate), 4, argv);
        topicBuffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) {
            FailSocketCallback(socket, socketObject);
        }
    };
    behavior.close = [context, close](
                         NativeWebSocket *socket,
                         int code,
                         std::string_view reason) {
        SocketState *socketState = socket->getUserData()->state;
        if (!socketState) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        const bool hasObject = !socketState->object.IsEmpty();
        if (hasObject) {
            socketObject = socketState->object.Get(callbackIsolate);
            SetInternalPointer(socketObject, nullptr);
        }
        socketState->socket = nullptr;
        socket->getUserData()->state = nullptr;
        if (close && !socketState->callbackFailed && hasObject) {
            Local<ArrayBuffer> reasonBuffer = ExternalArrayBuffer(callbackIsolate, reason);
            Local<Value> argv[] = {
                socketObject,
                Number::New(callbackIsolate, code),
                reasonBuffer};
            const bool callbackSucceeded =
                CallJs(callbackIsolate, close->Get(callbackIsolate), 3, argv);
            reasonBuffer->Detach(Local<Value>()).FromMaybe(false);
            if (!callbackSucceeded) socketState->callbackFailed = true;
        }
        socketState->object.Reset();
        socketState->userData.Reset();
        delete socketState;
    };

    NativeBytes path(isolate, args[0]);
    if (!path.IsValid()) {
        ThrowTypeError(isolate, "app.ws(path, behavior) path expects a string or buffer");
        return;
    }
    state->app->ws<PerSocketData>(std::string(path.View()), std::move(behavior));
    state->hasWebSockets = true;
    args.GetReturnValue().Set(args.This());
}

void AppPublish(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() < 2 || args.Length() > 4 ||
        (args.Length() > 2 && !args[2]->IsBoolean()) ||
        (args.Length() > 3 && !args[3]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "app.publish(topic, message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    NativeBytes message(args.GetIsolate(), args[1]);
    if (!topic.IsValid() || !message.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "app.publish topic and message expect strings or buffers");
        return;
    }
    if (!state->hasWebSockets) {
        args.GetReturnValue().Set(false);
        return;
    }
    const bool isBinary = args.Length() > 2 &&
        args[2]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 3 &&
        args[3]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->app->publish(
            topic.View(),
            message.View(),
            isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
            compress)));
}

void AppNumSubscribers(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a topic");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(
            args.GetIsolate(),
            "app.numSubscribers(topic) expects a string or buffer");
        return;
    }
    if (!state->hasWebSockets) {
        args.GetReturnValue().Set(0);
        return;
    }
    args.GetReturnValue().Set(state->app->numSubscribers(topic.View()));
}

void AppListen(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    const bool portOnly = args.Length() >= 2 && args.Length() <= 3 &&
        args[0]->IsNumber() && args[args.Length() - 1]->IsFunction();
    const bool withHost = args.Length() >= 3 && args.Length() <= 4 &&
        !args[0]->IsNumber() && args[1]->IsNumber() &&
        args[args.Length() - 1]->IsFunction();
    if (!state || (!portOnly && !withHost) ||
        (((portOnly && args.Length() == 3) || (withHost && args.Length() == 4)) &&
         !args[args.Length() - 2]->IsNumber())) {
        ThrowTypeError(
            isolate,
            "app.listen() expects (port[, options], callback) or (host, port[, options], callback)");
        return;
    }
    if (state->closed) {
        ThrowError(isolate, "app.listen() cannot be called after app.close()");
        return;
    }
    const int portIndex = withHost ? 1 : 0;
    const int callbackIndex = args.Length() - 1;
    const double portNumber =
        args[portIndex]->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
    if (!std::isfinite(portNumber) || std::floor(portNumber) != portNumber ||
        portNumber < 0 || portNumber > 65535) {
        ThrowTypeError(isolate, "app.listen() port must be between 0 and 65535");
        return;
    }
    const int port = static_cast<int>(portNumber);
    const bool hasOptions = callbackIndex - portIndex == 2;
    int options = LIBUS_LISTEN_DEFAULT;
    if (hasOptions) {
        const double optionsNumber = args[callbackIndex - 1]
                                         ->NumberValue(isolate->GetCurrentContext())
                                         .FromMaybe(-1);
        if (!std::isfinite(optionsNumber) || std::floor(optionsNumber) != optionsNumber ||
            optionsNumber < 0 || optionsNumber > 1) {
            ThrowTypeError(isolate, "app.listen() options must be 0 or 1");
            return;
        }
        options = static_cast<int>(optionsNumber);
    }
    auto callback = std::make_unique<Global<Function>>(
        isolate,
        args[callbackIndex].As<Function>());
    Global<Function> *callbackPointer = callback.get();
    state->handlers.push_back(std::move(callback));
    bool callbackSucceeded = true;
    auto listener = [state, isolate, callbackPointer, &callbackSucceeded](
                        us_listen_socket_t *socket) {
        if (socket) state->listenSockets.push_back(socket);
        HandleScope scope(isolate);
        Local<Value> socketValue = v8::False(isolate);
        if (socket) socketValue = External::New(isolate, socket);
        Local<Value> argv[] = {socketValue};
        callbackSucceeded =
            CallJs(isolate, callbackPointer->Get(isolate), 1, argv);
        if (!callbackSucceeded && socket) {
            auto position = std::find(
                state->listenSockets.begin(),
                state->listenSockets.end(),
                socket);
            if (position != state->listenSockets.end()) {
                state->listenSockets.erase(position);
                us_listen_socket_close(0, socket);
            }
        }
    };
    if (withHost) {
        NativeBytes host(isolate, args[0]);
        if (!host.IsValid()) {
            ThrowTypeError(isolate, "app.listen() host expects a string or buffer");
            return;
        }
        state->app->listen(
            std::string(host.View()),
            port,
            options,
            std::move(listener));
    } else {
        state->app->listen(port, options, std::move(listener));
    }
    if (!callbackSucceeded) return;
    args.GetReturnValue().Set(args.This());
}

void AppListenUnix(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    const bool withoutOptions = args.Length() == 2 && args[0]->IsFunction();
    const bool withOptions = args.Length() == 3 && args[0]->IsNumber() &&
        args[1]->IsFunction();
    if (!state || (!withoutOptions && !withOptions)) {
        ThrowTypeError(
            isolate,
            "app.listen_unix() expects (callback, path) or (options, callback, path)");
        return;
    }
    if (state->closed) {
        ThrowError(isolate, "app.listen_unix() cannot be called after app.close()");
        return;
    }

    const int callbackIndex = withOptions ? 1 : 0;
    const int pathIndex = withOptions ? 2 : 1;
    int options = LIBUS_LISTEN_DEFAULT;
    if (withOptions) {
        const double optionsNumber =
            args[0]->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
        if (!std::isfinite(optionsNumber) || std::floor(optionsNumber) != optionsNumber ||
            optionsNumber < 0 || optionsNumber > 1) {
            ThrowTypeError(isolate, "app.listen_unix() options must be 0 or 1");
            return;
        }
        options = static_cast<int>(optionsNumber);
    }
    NativeBytes path(isolate, args[pathIndex]);
    if (!path.IsValid()) {
        ThrowTypeError(isolate, "app.listen_unix() path expects a string or buffer");
        return;
    }
    auto callback = std::make_unique<Global<Function>>(
        isolate,
        args[callbackIndex].As<Function>());
    Global<Function> *callbackPointer = callback.get();
    state->handlers.push_back(std::move(callback));
    bool callbackSucceeded = true;
    state->app->listen(
        options,
        [state, isolate, callbackPointer, &callbackSucceeded](
            us_listen_socket_t *socket) {
            if (socket) state->listenSockets.push_back(socket);
            HandleScope scope(isolate);
            Local<Value> socketValue = v8::False(isolate);
            if (socket) socketValue = External::New(isolate, socket);
            Local<Value> argv[] = {socketValue};
            callbackSucceeded =
                CallJs(isolate, callbackPointer->Get(isolate), 1, argv);
            if (!callbackSucceeded && socket) {
                auto position = std::find(
                    state->listenSockets.begin(),
                    state->listenSockets.end(),
                    socket);
                if (position != state->listenSockets.end()) {
                    state->listenSockets.erase(position);
                    us_listen_socket_close(0, socket);
                }
            }
        },
        std::string(path.View()));
    if (!callbackSucceeded) return;
    args.GetReturnValue().Set(args.This());
}

void AppFilter(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(isolate, "app.filter(handler) expects a function");
        return;
    }
    auto handler = std::make_unique<Global<Function>>(isolate, args[0].As<Function>());
    Global<Function> *handlerPointer = handler.get();
    state->handlers.push_back(std::move(handler));
    PerContextData *context = state->context;
    state->app->filter([context, handlerPointer](HttpResponse *response, int count) {
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->responseTemplate.Get(callbackIsolate)->Clone();
        SetInternalPointer(responseObject, response, 0);
        Local<Value> argv[] = {
            responseObject,
            Number::New(callbackIsolate, count)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        if (!callbackSucceeded && count > 0 && GetInternalPointer(responseObject)) {
            response->close();
        }
        if (GetInternalPointer(responseObject)) InvalidateResponseObject(responseObject);
    });
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
        for (us_listen_socket_t *socket : state->listenSockets) {
            us_listen_socket_close(0, socket);
        }
        state->listenSockets.clear();
        if (state->app) state->app->close();
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
    args.GetReturnValue().Set(NewString(
        args.GetIsolate(),
        SWM_UWS_VERSION "+uWebSockets-" SWM_UWS_UPSTREAM_VERSION));
}

void Capabilities(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Object> result = Object::New(isolate);
    const char *names[] = {
        "beginWrite",
        "collectBody",
        "requestSnapshot",
        "responseBatch",
        "requestPause",
    };
    for (const char *name : names) {
        result
            ->CreateDataProperty(
                context,
                NewString(isolate, name),
                Boolean::New(isolate, true))
            .ToChecked();
    }
    args.GetReturnValue().Set(result);
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
        auto &sockets = app->listenSockets;
        sockets.erase(std::remove(sockets.begin(), sockets.end(), socket), sockets.end());
    }
    us_listen_socket_close(0, socket);
}

void SocketLocalPort(const FunctionCallbackInfo<Value> &args) {
    if (args.Length() != 1 || !args[0]->IsExternal()) {
        ThrowTypeError(
            args.GetIsolate(),
            "us_socket_local_port(socket) expects a socket or listen socket");
        return;
    }
    auto *socket = static_cast<us_socket_t *>(args[0].As<External>()->Value());
    args.GetReturnValue().Set(
        Number::New(args.GetIsolate(), us_socket_local_port(0, socket)));
}

void SetPrototypeMethod(
    Isolate *isolate,
    Local<FunctionTemplate> target,
    const char *name,
    v8::FunctionCallback callback,
    Local<Value> data = Local<Value>()) {
    target->PrototypeTemplate()->Set(
        isolate,
        name,
        FunctionTemplate::New(isolate, callback, data));
}

PerContextData *Initialize(Isolate *isolate, Local<Object> exports) {
    auto *context = new PerContextData;
    context->isolate = isolate;
    Local<External> contextExternal = External::New(isolate, context);

    Local<FunctionTemplate> response = FunctionTemplate::New(isolate);
    response->InstanceTemplate()->SetInternalFieldCount(3);
    SetPrototypeMethod(isolate, response, "end", ResponseEnd);
    SetPrototypeMethod(isolate, response, "endWithoutBody", ResponseEndWithoutBody);
    SetPrototypeMethod(isolate, response, "close", ResponseClose);
    SetPrototypeMethod(isolate, response, "endBatch", ResponseEndBatch);
    SetPrototypeMethod(isolate, response, "writeStatus", ResponseWriteStatus);
    SetPrototypeMethod(
        isolate,
        response,
        "writeHeader",
        ResponseWriteHeader,
        contextExternal);
    SetPrototypeMethod(isolate, response, "cork", ResponseCork);
    SetPrototypeMethod(isolate, response, "collect", ResponseCork);
    SetPrototypeMethod(isolate, response, "beginWrite", ResponseBeginWrite);
    SetPrototypeMethod(isolate, response, "write", ResponseWrite);
    SetPrototypeMethod(isolate, response, "tryEnd", ResponseTryEnd);
    SetPrototypeMethod(isolate, response, "onWritable", ResponseOnWritable);
    SetPrototypeMethod(isolate, response, "getWriteOffset", ResponseGetWriteOffset);
    SetPrototypeMethod(
        isolate,
        response,
        "getRemoteAddress",
        ResponseGetRemoteAddress);
    SetPrototypeMethod(
        isolate,
        response,
        "getRemoteAddressAsText",
        ResponseGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, response, "getRemotePort", ResponseGetRemotePort);
    SetPrototypeMethod(
        isolate,
        response,
        "getProxiedRemoteAddress",
        ResponseGetProxiedRemoteAddress);
    SetPrototypeMethod(
        isolate,
        response,
        "getProxiedRemoteAddressAsText",
        ResponseGetProxiedRemoteAddressAsText);
    SetPrototypeMethod(
        isolate,
        response,
        "getProxiedRemotePort",
        ResponseGetProxiedRemotePort);
    SetPrototypeMethod(isolate, response, "upgrade", ResponseUpgrade);
    SetPrototypeMethod(isolate, response, "onData", ResponseOnData);
    SetPrototypeMethod(isolate, response, "onDataV2", ResponseOnDataV2);
    SetPrototypeMethod(isolate, response, "collectBody", ResponseCollectBody);
    SetPrototypeMethod(isolate, response, "pause", ResponsePause);
    SetPrototypeMethod(isolate, response, "resume", ResponseResume);
    SetPrototypeMethod(isolate, response, "onAborted", ResponseOnAborted);
    Local<Object> responseTemplate = response->GetFunction(isolate->GetCurrentContext())
                                         .ToLocalChecked()
                                         ->NewInstance(isolate->GetCurrentContext())
                                         .ToLocalChecked();
    SetInternalPointer(responseTemplate, nullptr, 0);
    SetInternalPointer(responseTemplate, nullptr, 1);
    SetInternalPointer(responseTemplate, nullptr, 2);
    context->responseTemplate.Reset(isolate, responseTemplate);

    Local<FunctionTemplate> request = FunctionTemplate::New(isolate);
    request->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, request, "getMethod", RequestGetMethod);
    SetPrototypeMethod(
        isolate,
        request,
        "getCaseSensitiveMethod",
        RequestGetCaseSensitiveMethod);
    SetPrototypeMethod(isolate, request, "getUrl", RequestGetUrl);
    SetPrototypeMethod(isolate, request, "getHeader", RequestGetHeader);
    SetPrototypeMethod(isolate, request, "getQuery", RequestGetQuery);
    SetPrototypeMethod(isolate, request, "getParameter", RequestGetParameter);
    SetPrototypeMethod(isolate, request, "setYield", RequestSetYield);
    SetPrototypeMethod(isolate, request, "forEach", RequestForEach);
    SetPrototypeMethod(
        isolate,
        request,
        "snapshot",
        RequestSnapshot,
        contextExternal);
    // Clones keep one dictionary map; separate null-prototype Object::New calls do not.
    context->requestHeadersTemplate.Reset(
        isolate,
        Object::New(isolate, Null(isolate), nullptr, nullptr, 0));
    context->requestTemplate.Reset(
        isolate,
        request->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> socket = FunctionTemplate::New(isolate);
    socket->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, socket, "send", SocketSend);
    SetPrototypeMethod(isolate, socket, "sendFirstFragment", SocketSendFirstFragment);
    SetPrototypeMethod(isolate, socket, "sendFragment", SocketSendFragment);
    SetPrototypeMethod(isolate, socket, "sendLastFragment", SocketSendLastFragment);
    SetPrototypeMethod(isolate, socket, "ping", SocketPing);
    SetPrototypeMethod(isolate, socket, "publish", SocketPublish);
    SetPrototypeMethod(isolate, socket, "cork", SocketCork);
    SetPrototypeMethod(isolate, socket, "end", SocketEnd);
    SetPrototypeMethod(isolate, socket, "close", SocketClose);
    SetPrototypeMethod(isolate, socket, "getBufferedAmount", SocketGetBufferedAmount);
    SetPrototypeMethod(isolate, socket, "getRemoteAddress", SocketGetRemoteAddress);
    SetPrototypeMethod(
        isolate,
        socket,
        "getRemoteAddressAsText",
        SocketGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, socket, "getRemotePort", SocketGetRemotePort);
    SetPrototypeMethod(isolate, socket, "getUserData", SocketGetUserData);
    SetPrototypeMethod(isolate, socket, "subscribe", SocketSubscribe);
    SetPrototypeMethod(isolate, socket, "unsubscribe", SocketUnsubscribe);
    SetPrototypeMethod(isolate, socket, "isSubscribed", SocketIsSubscribed);
    SetPrototypeMethod(isolate, socket, "getTopics", SocketGetTopics);
    context->socketTemplate.Reset(
        isolate,
        socket->GetFunction(isolate->GetCurrentContext())
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
    SetPrototypeMethod(isolate, app, "connect", AppConnect);
    SetPrototypeMethod(isolate, app, "trace", AppTrace);
    SetPrototypeMethod(isolate, app, "any", AppAny);
    SetPrototypeMethod(isolate, app, "ws", AppWs);
    SetPrototypeMethod(isolate, app, "publish", AppPublish);
    SetPrototypeMethod(isolate, app, "numSubscribers", AppNumSubscribers);
    SetPrototypeMethod(isolate, app, "listen", AppListen);
    SetPrototypeMethod(isolate, app, "listen_unix", AppListenUnix);
    SetPrototypeMethod(isolate, app, "filter", AppFilter);
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
            NewString(isolate, "capabilities"),
            FunctionTemplate::New(isolate, Capabilities)
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
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "us_socket_local_port"),
            FunctionTemplate::New(isolate, SocketLocalPort)
                ->GetFunction(isolate->GetCurrentContext())
                .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "LIBUS_LISTEN_EXCLUSIVE_PORT"),
            Number::New(isolate, LIBUS_LISTEN_EXCLUSIVE_PORT))
        .ToChecked();
    exports
        ->Set(
            isolate->GetCurrentContext(),
            NewString(isolate, "DISABLED"),
            Number::New(isolate, uWS::CompressOptions::DISABLED))
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
            contextData->requestHeadersTemplate.Reset();
            contextData->socketTemplate.Reset();
            contextData->appConstructor.Reset();
            uWS::Loop::get()->free();
            delete contextData;
        },
        data);
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitializeModule)
