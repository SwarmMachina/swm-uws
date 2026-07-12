#include <App.h>
#include <node.h>
#include <v8.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
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
using v8::Null;
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
    bool hasWebSockets = false;
    std::vector<std::unique_ptr<Global<Function>>> handlers;
};

struct PerContextData {
    Isolate *isolate;
    Global<Object> responseTemplate;
    Global<Object> requestTemplate;
    Global<Object> socketTemplate;
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

struct SocketState;

struct PerSocketData {
    SocketState *state = nullptr;
};

using NativeWebSocket = uWS::WebSocket<false, true, PerSocketData>;

struct SocketState {
    Isolate *isolate = nullptr;
    NativeWebSocket *socket = nullptr;
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
        handler
            ->Call(
                isolate->GetCurrentContext(),
                isolate->GetCurrentContext()->Global(),
                0,
                nullptr)
            .IsEmpty();
    });
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

void ResponseUpgrade(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 5 || !args[1]->IsString() || !args[2]->IsString() ||
        !args[3]->IsString() || !args[4]->IsExternal()) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.upgrade(userData, key, protocol, extensions, context) received invalid arguments");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    NativeBytes key(isolate, args[1]);
    NativeBytes protocol(isolate, args[2]);
    NativeBytes extensions(isolate, args[3]);
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
        CallJs(isolate, state->dataHandler.Get(isolate), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
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
            if (chunk.size() > maxSize - collection->bytes.size()) {
                collection->completed = true;
                Local<Value> argv[] = {Null(callbackIsolate)};
                CallJs(callbackIsolate, state->dataHandler.Get(callbackIsolate), 1, argv);
                state->dataHandler.Reset();
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
                CallJs(callbackIsolate, state->dataHandler.Get(callbackIsolate), 1, argv);
                state->dataHandler.Reset();
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
            CallJs(callbackIsolate, state->dataHandler.Get(callbackIsolate), 1, argv);
            state->dataHandler.Reset();
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
}

void ResponseResume(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.resume() does not accept arguments");
        return;
    }
    response->resume();
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
        if (handler
                ->Call(
                    isolate->GetCurrentContext(),
                    isolate->GetCurrentContext()->Global(),
                    2,
                    argv)
                .IsEmpty()) {
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
    Local<Object> headers = Object::New(isolate);
    if (!headers->SetPrototype(context, Null(isolate)).FromMaybe(false)) return;

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
    const bool isBinary = args.Length() > 1
        ? args[1]->BooleanValue(args.GetIsolate())
        : !args[0]->IsString();
    const bool compress = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(state->socket->send(
        message.View(),
        isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
        compress)));
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
        (args.Length() > 0 && !args[0]->IsUndefined() && !args[0]->IsNumber()) ||
        (args.Length() > 1 && !args[1]->IsUndefined() && !args[1]->IsString())) {
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
    state->socket->end(code, reason.View());
    args.GetReturnValue().Set(args.This());
}

void SocketClose(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.close() does not accept arguments");
        return;
    }
    state->socket->close();
    args.GetReturnValue().Set(args.This());
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
    if (!state->userData.IsEmpty()) {
        args.GetReturnValue().Set(state->userData.Get(args.GetIsolate()));
    }
}

void SocketSubscribe(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "ws.subscribe(topic) expects a string");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->socket->subscribe(topic.View())));
}

void SocketUnsubscribe(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "ws.unsubscribe(topic) expects a string");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
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

Local<Value> GetProperty(Isolate *isolate, Local<Object> object, const char *name) {
    return object->Get(isolate->GetCurrentContext(), NewString(isolate, name))
        .ToLocalChecked();
}

bool ReadUnsignedOption(
    Isolate *isolate,
    Local<Object> options,
    const char *name,
    unsigned int minimum,
    unsigned int maximum,
    unsigned int *target) {
    Local<Value> value = GetProperty(isolate, options, name);
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
    Local<Value> value = GetProperty(isolate, options, name);
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
    AppState *state,
    Isolate *isolate,
    Local<Object> options,
    const char *name,
    bool *valid) {
    Local<Value> value = GetProperty(isolate, options, name);
    if (value->IsUndefined()) return nullptr;
    if (!value->IsFunction()) {
        ThrowTypeError(isolate, "WebSocket handlers must be functions");
        *valid = false;
        return nullptr;
    }
    auto handler = std::make_unique<Global<Function>>(isolate, value.As<Function>());
    Global<Function> *pointer = handler.get();
    state->handlers.push_back(std::move(handler));
    return pointer;
}

Local<Object> EnsureSocketObject(
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
        SetInternalPointer(object, state);
        state->object.Reset(isolate, object);
        return object;
    }
    return state->object.Get(isolate);
}

void AppWs(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 2 || !args[0]->IsString() || !args[1]->IsObject()) {
        ThrowTypeError(isolate, "app.ws(path, behavior) expects a string and an object");
        return;
    }
    Local<Object> options = args[1].As<Object>();
    uWS::App::WebSocketBehavior<PerSocketData> behavior;
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
    Global<Function> *upgrade = StoreOptionalHandler(state, isolate, options, "upgrade", &handlersValid);
    if (!handlersValid) return;
    Global<Function> *open = StoreOptionalHandler(state, isolate, options, "open", &handlersValid);
    if (!handlersValid) return;
    Global<Function> *message = StoreOptionalHandler(state, isolate, options, "message", &handlersValid);
    if (!handlersValid) return;
    Global<Function> *drain = StoreOptionalHandler(state, isolate, options, "drain", &handlersValid);
    if (!handlersValid) return;
    Global<Function> *subscription = StoreOptionalHandler(state, isolate, options, "subscription", &handlersValid);
    if (!handlersValid) return;
    Global<Function> *close = StoreOptionalHandler(state, isolate, options, "close", &handlersValid);
    if (!handlersValid) return;

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
            SetInternalPointer(responseObject, nullptr, 1);
            SetInternalPointer(requestObject, request);
            Local<Value> argv[] = {
                responseObject,
                requestObject,
                External::New(callbackIsolate, socketContext)};
            CallJs(callbackIsolate, upgrade->Get(callbackIsolate), 3, argv);
            SetInternalPointer(requestObject, nullptr);
            if (GetInternalPointer(responseObject) &&
                !GetInternalPointer(responseObject, 1)) {
                response->close();
                InvalidateResponseObject(responseObject);
            }
        };
    }
    behavior.open = [context, open](NativeWebSocket *socket) {
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject = EnsureSocketObject(context, socket);
        if (open) {
            Local<Value> argv[] = {socketObject};
            CallJs(callbackIsolate, open->Get(callbackIsolate), 1, argv);
        }
    };
    behavior.message = [context, message](
                           NativeWebSocket *socket,
                           std::string_view payload,
                           uWS::OpCode opcode) {
        if (!message) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject = EnsureSocketObject(context, socket);
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(callbackIsolate, payload);
        Local<Value> argv[] = {
            socketObject,
            buffer,
            Boolean::New(callbackIsolate, opcode == uWS::OpCode::BINARY)};
        CallJs(callbackIsolate, message->Get(callbackIsolate), 3, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
    };
    behavior.drain = [context, drain](NativeWebSocket *socket) {
        if (!drain) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Value> argv[] = {EnsureSocketObject(context, socket)};
        CallJs(callbackIsolate, drain->Get(callbackIsolate), 1, argv);
    };
    behavior.subscription = [context, subscription](
                                NativeWebSocket *socket,
                                std::string_view topic,
                                int newCount,
                                int oldCount) {
        if (!subscription) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<ArrayBuffer> topicBuffer = ExternalArrayBuffer(callbackIsolate, topic);
        Local<Value> argv[] = {
            EnsureSocketObject(context, socket),
            topicBuffer,
            Number::New(callbackIsolate, newCount),
            Number::New(callbackIsolate, oldCount)};
        CallJs(callbackIsolate, subscription->Get(callbackIsolate), 4, argv);
        topicBuffer->Detach(Local<Value>()).FromMaybe(false);
    };
    behavior.close = [context, close](
                         NativeWebSocket *socket,
                         int code,
                         std::string_view reason) {
        SocketState *socketState = socket->getUserData()->state;
        if (!socketState) return;
        Isolate *callbackIsolate = context->isolate;
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject = socketState->object.Get(callbackIsolate);
        SetInternalPointer(socketObject, nullptr);
        socketState->socket = nullptr;
        socket->getUserData()->state = nullptr;
        if (close) {
            Local<ArrayBuffer> reasonBuffer = ExternalArrayBuffer(callbackIsolate, reason);
            Local<Value> argv[] = {
                socketObject,
                Number::New(callbackIsolate, code),
                reasonBuffer};
            CallJs(callbackIsolate, close->Get(callbackIsolate), 3, argv);
            reasonBuffer->Detach(Local<Value>()).FromMaybe(false);
        }
        socketState->object.Reset();
        socketState->userData.Reset();
        delete socketState;
    };

    NativeBytes path(isolate, args[0]);
    state->app->ws<PerSocketData>(std::string(path.View()), std::move(behavior));
    state->hasWebSockets = true;
    args.GetReturnValue().Set(args.This());
}

void AppPublish(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() < 2 || args.Length() > 3 || !args[0]->IsString() ||
        (args.Length() > 2 && !args[2]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "app.publish(topic, message, isBinary) received invalid arguments");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    NativeBytes message(args.GetIsolate(), args[1]);
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "app.publish message expects a string or buffer");
        return;
    }
    if (!state->hasWebSockets) {
        args.GetReturnValue().Set(false);
        return;
    }
    const bool isBinary = args.Length() > 2
        ? args[2]->BooleanValue(args.GetIsolate())
        : !args[1]->IsString();
    args.GetReturnValue().Set(Boolean::New(
        args.GetIsolate(),
        state->app->publish(
            topic.View(),
            message.View(),
            isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT)));
}

void AppNumSubscribers(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a string");
        return;
    }
    if (!state->hasWebSockets) {
        args.GetReturnValue().Set(0);
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    args.GetReturnValue().Set(state->app->numSubscribers(topic.View()));
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
    SetPrototypeMethod(isolate, response, "endBatch", ResponseEndBatch);
    SetPrototypeMethod(isolate, response, "writeStatus", ResponseWriteStatus);
    SetPrototypeMethod(isolate, response, "writeHeader", ResponseWriteHeader);
    SetPrototypeMethod(isolate, response, "cork", ResponseCork);
    SetPrototypeMethod(isolate, response, "beginWrite", ResponseBeginWrite);
    SetPrototypeMethod(isolate, response, "write", ResponseWrite);
    SetPrototypeMethod(isolate, response, "tryEnd", ResponseTryEnd);
    SetPrototypeMethod(isolate, response, "onWritable", ResponseOnWritable);
    SetPrototypeMethod(isolate, response, "getWriteOffset", ResponseGetWriteOffset);
    SetPrototypeMethod(
        isolate,
        response,
        "getRemoteAddressAsText",
        ResponseGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, response, "upgrade", ResponseUpgrade);
    SetPrototypeMethod(isolate, response, "onData", ResponseOnData);
    SetPrototypeMethod(isolate, response, "collectBody", ResponseCollectBody);
    SetPrototypeMethod(isolate, response, "pause", ResponsePause);
    SetPrototypeMethod(isolate, response, "resume", ResponseResume);
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
    SetPrototypeMethod(isolate, request, "snapshot", RequestSnapshot);
    context->requestTemplate.Reset(
        isolate,
        request->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked());

    Local<FunctionTemplate> socket = FunctionTemplate::New(isolate);
    socket->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, socket, "send", SocketSend);
    SetPrototypeMethod(isolate, socket, "end", SocketEnd);
    SetPrototypeMethod(isolate, socket, "close", SocketClose);
    SetPrototypeMethod(isolate, socket, "getBufferedAmount", SocketGetBufferedAmount);
    SetPrototypeMethod(isolate, socket, "getUserData", SocketGetUserData);
    SetPrototypeMethod(isolate, socket, "subscribe", SocketSubscribe);
    SetPrototypeMethod(isolate, socket, "unsubscribe", SocketUnsubscribe);
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
    SetPrototypeMethod(isolate, app, "any", AppAny);
    SetPrototypeMethod(isolate, app, "ws", AppWs);
    SetPrototypeMethod(isolate, app, "publish", AppPublish);
    SetPrototypeMethod(isolate, app, "numSubscribers", AppNumSubscribers);
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
            contextData->socketTemplate.Reset();
            contextData->appConstructor.Reset();
            uWS::Loop::get()->free();
            delete contextData;
        },
        data);
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, InitializeModule)
