#include "binding_internal.h"

namespace swm::binding {

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
    if (!state->IsValid()) return;
    Local<Object> object = state->Object();
    InvalidateResponseObject(object);
    SetInternalPointer(object, nullptr, 1);
    state->Invalidate();
}

void CloseAsyncResponseAfterCallbackFailure(const std::shared_ptr<AsyncResponseState> &state) {
    if (!state->IsValid()) return;
    HttpResponse *response = state->Response();
    InvalidateAsyncResponse(state);
    response->close();
}

std::shared_ptr<AsyncResponseState> PromoteResponse(const FunctionCallbackInfo<Value> &args) {
    auto *existing = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    if (existing) {
        return existing->shared_from_this();
    }

    auto state = std::make_shared<AsyncResponseState>(
        args.GetIsolate(),
        static_cast<HttpResponse *>(GetInternalPointer(args.This())),
        args.This());
    SetInternalPointer(args.This(), state.get(), 1);
    state->Response()->onAborted([state]() {
        Isolate *isolate = state->Isolate();
        HandleScope scope(isolate);
        Local<Function> handler;
        const bool hasHandler = state->HasActiveAbortedHandler();
        if (hasHandler) handler = state->AbortedHandler();
        InvalidateAsyncResponse(state);
        if (hasHandler && !CallJs(isolate, handler, 0, nullptr)) return;
    });
    return state;
}

void ResponseEnd(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;

    if (args.Length() > 2) {
        ThrowTypeError(args.GetIsolate(),
                       "res.end(body?, closeConnection?) received too many arguments");
        return;
    }

    NativeBytes body(args.GetIsolate(), args[0], true);
    if (!body.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "res.end(body) expects a string or buffer");
        return;
    }
    const bool closeConnection = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
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
        ThrowTypeError(args.GetIsolate(),
                       "res.endWithoutBody(reportedContentLength?, closeConnection?) received "
                       "invalid arguments");
        return;
    }

    std::optional<std::size_t> reportedContentLength;
    if (args.Length() > 0 && !args[0]->IsUndefined()) {
        const double length =
            args[0]->NumberValue(args.GetIsolate()->GetCurrentContext()).FromMaybe(-1);
        if (!std::isfinite(length) || length < 0 || length > 9007199254740991.0 ||
            std::floor(length) != length) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.endWithoutBody() content length must be a non-negative safe integer");
            return;
        }
        reportedContentLength = static_cast<std::size_t>(length);
    }
    const bool closeConnection = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState =
        async ? async->shared_from_this() : std::shared_ptr<AsyncResponseState>();
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
    std::shared_ptr<AsyncResponseState> asyncState =
        async ? async->shared_from_this() : std::shared_ptr<AsyncResponseState>();
    if (asyncState) {
        response->close();
        if (asyncState->IsValid()) InvalidateAsyncResponse(asyncState);
    } else {
        InvalidateResponseObject(args.This());
        response->close();
    }
    args.GetReturnValue().Set(args.This());
}

void ResponseEndBatch(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if ((args.Length() != 2 && args.Length() != 3) || !args[0]->IsString() || !args[1]->IsArray()) {
        ThrowTypeError(args.GetIsolate(),
                       "res.endBatch(status, headerLines, body?) expects a status string and a "
                       "flat header array");
        return;
    }

    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    NativeBytes status(isolate, args[0]);
    if (!IsValidStatus(status.View())) {
        ThrowTypeError(isolate, "res.endBatch(status, headerLines, body?) expects a valid status");
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
        if (!IsValidHeaderName(name.View()) || ContainsInvalidHeaderValueCharacter(value.View())) {
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
    std::shared_ptr<AsyncResponseState> asyncState =
        async ? async->shared_from_this() : std::shared_ptr<AsyncResponseState>();
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
        ThrowTypeError(args.GetIsolate(), "res.writeStatus(status) expects a string or buffer");
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
        ThrowTypeError(args.GetIsolate(),
                       "res.writeHeader(name, value) expects strings or buffers");
        return;
    }
    NativeBytes name(args.GetIsolate(), args[0]);
    NativeBytes value(args.GetIsolate(), args[1]);
    if (!name.IsValid() || !value.IsValid()) {
        ThrowTypeError(args.GetIsolate(),
                       "res.writeHeader(name, value) expects strings or buffers");
        return;
    }
    auto *context = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    const bool cachedName =
        args[0]->IsString() && context->IsKnownResponseHeaderName(args[0].As<String>());
    if (!cachedName) {
        if (!IsValidHeaderName(name.View())) {
            ThrowTypeError(args.GetIsolate(),
                           "res.writeHeader(name, value) expects a valid HTTP header name");
            return;
        }
        if (args[0]->IsString()) {
            context->RememberResponseHeaderName(args[0].As<String>());
        }
    }
    if (IsBindingManagedFramingHeader(name.View())) {
        ThrowTypeError(
            args.GetIsolate(),
            "res.writeHeader() manages Content-Length and Transfer-Encoding automatically");
        return;
    }
    const bool cachedValue =
        args[1]->IsString() && context->IsKnownResponseHeaderValue(args[1].As<String>());
    if (!cachedValue) {
        if (ContainsInvalidHeaderValueCharacter(value.View())) {
            ThrowTypeError(
                args.GetIsolate(),
                "res.writeHeader(name, value) does not allow control characters in value");
            return;
        }
        if (args[1]->IsString()) {
            context->RememberResponseHeaderValue(args[1].As<String>());
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
    HttpResponse *updated =
        response->cork([isolate, handler, &callbackSucceeded, &callbackException]() {
            callbackSucceeded = CallJsDirect(isolate, handler, 0, nullptr, callbackException);
        });
    if (!callbackSucceeded) {
        if (GetInternalPointer(args.This())) {
            auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
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
        ThrowTypeError(args.GetIsolate(),
                       "res.tryEnd(chunk, totalSize) expects a string or buffer and a number");
        return;
    }
    NativeBytes chunk(args.GetIsolate(), args[0]);
    const double totalNumber =
        args[1]->NumberValue(args.GetIsolate()->GetCurrentContext()).FromMaybe(-1);
    if (!chunk.IsValid() || !std::isfinite(totalNumber) || totalNumber < 0 ||
        totalNumber > 9007199254740991.0 || std::floor(totalNumber) != totalNumber) {
        ThrowTypeError(args.GetIsolate(),
                       "res.tryEnd(chunk, totalSize) expects a string or buffer and a valid size");
        return;
    }
    ResponseMetadata *metadata = GetResponseMetadata(args.This());
    const uintmax_t totalSize = totalNumber == 0 ? static_cast<uintmax_t>(chunk.View().size())
                                                 : static_cast<uintmax_t>(totalNumber);
    if (!metadata->chunked) {
        const uintmax_t offset = response->getWriteOffset();
        if ((metadata->tryEndTotal && *metadata->tryEndTotal != totalSize) || offset > totalSize ||
            chunk.View().size() > totalSize - offset) {
            ThrowTypeError(args.GetIsolate(),
                           "res.tryEnd() chunk exceeds or conflicts with the declared total size");
            return;
        }
        metadata->tryEndTotal = totalSize;
    }

    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState =
        async ? async->shared_from_this() : std::shared_ptr<AsyncResponseState>();
    const auto [ok, done] = response->tryEnd(chunk.View(), totalSize);
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
    if (state->HasWritableHandler()) {
        ThrowError(args.GetIsolate(), "res.onWritable() handler is already registered");
        return;
    }
    state->RegisterWritableHandler(args[0].As<Function>());
    state->Response()->onWritable([state](uintmax_t offset) {
        if (!state->IsValid() || !state->HasActiveWritableHandler()) return false;
        Isolate *isolate = state->Isolate();
        HandleScope scope(isolate);
        Local<Value> argv[] = {Number::New(isolate, static_cast<double>(offset))};
        Local<Value> result;
        if (!CallJsValue(isolate, state->WritableHandler(), 1, argv, &result)) {
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
        const_cast<char *>(value.data()), value.length(), [](void *, size_t, void *) {}, nullptr);
    return ArrayBuffer::New(isolate, std::move(backing));
}

void ResponseGetRemoteAddressAsText(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.getRemoteAddressAsText() does not accept arguments");
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
    args.GetReturnValue().Set(CopyToArrayBuffer(args.GetIsolate(), response->getRemoteAddress()));
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
        ThrowTypeError(args.GetIsolate(),
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
        ThrowTypeError(args.GetIsolate(),
                       "res.getProxiedRemoteAddressAsText() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), response->getProxiedRemoteAddressAsText()));
}

void ResponseGetProxiedRemotePort(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = GetResponse(args);
    if (!response) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.getProxiedRemotePort() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), response->getProxiedRemotePort()));
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
        ThrowTypeError(isolate,
                       "res.upgrade() key, protocol and extensions expect strings or buffers");
        return;
    }
    auto *socketState = new SocketState(isolate);
    socketState->SetUserData(args[0]);
    auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(args.This(), 1));
    std::shared_ptr<AsyncResponseState> asyncState =
        async ? async->shared_from_this() : std::shared_ptr<AsyncResponseState>();
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
    if (state->HasDataHandler()) {
        ThrowError(args.GetIsolate(), "res.onData() handler is already registered");
        return;
    }
    state->RegisterDataHandler(args[0].As<Function>());
    state->Response()->onData([state](std::string_view chunk, bool isLast) {
        if (!state->IsValid() || !state->HasActiveDataHandler()) return;
        Isolate *isolate = state->Isolate();
        HandleScope scope(isolate);
        std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
            const_cast<char *>(chunk.data()),
            chunk.length(),
            [](void *, size_t, void *) {},
            nullptr);
        Local<ArrayBuffer> buffer = ArrayBuffer::New(isolate, std::move(backing));
        Local<Value> argv[] = {buffer, Boolean::New(isolate, isLast)};
        const bool callbackSucceeded = CallJs(isolate, state->DataHandler(), 2, argv);
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
    if (state->HasDataHandler()) {
        ThrowError(args.GetIsolate(), "res.onDataV2() body handler is already registered");
        return;
    }
    state->RegisterDataHandler(args[0].As<Function>());
    state->Response()->onDataV2([state](std::string_view chunk, uint64_t maxRemainingBodyLength) {
        if (!state->IsValid() || !state->HasActiveDataHandler()) return;
        Isolate *isolate = state->Isolate();
        HandleScope scope(isolate);
        Local<ArrayBuffer> buffer = ExternalArrayBuffer(isolate, chunk);
        Local<Value> argv[] = {buffer, BigInt::NewFromUnsigned(isolate, maxRemainingBodyLength)};
        const bool callbackSucceeded = CallJs(isolate, state->DataHandler(), 2, argv);
        buffer->Detach(Local<Value>()).FromMaybe(false);
        if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
    });
    args.GetReturnValue().Set(args.This());
}

void ResponseCollectBodyImpl(const FunctionCallbackInfo<Value> &args, bool returnBodyLength) {
    if (!GetResponse(args)) return;
    if (args.Length() != 2 || !args[0]->IsNumber() || !args[1]->IsFunction()) {
        ThrowTypeError(
            args.GetIsolate(),
            returnBodyLength
                ? "res.collectBodyWithLength(maxSize, handler) expects a size and a function"
                : "res.collectBody(maxSize, handler) expects a size and a function");
        return;
    }

    Isolate *isolate = args.GetIsolate();
    const double maxSizeNumber = args[0]->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
    constexpr double MaxCollectBodySize = 64.0 * 1024.0 * 1024.0;
    if (!std::isfinite(maxSizeNumber) || maxSizeNumber < 0 || maxSizeNumber > MaxCollectBodySize ||
        std::floor(maxSizeNumber) != maxSizeNumber) {
        ThrowTypeError(isolate,
                       returnBodyLength ? "res.collectBodyWithLength(maxSize, handler) maxSize "
                                          "must be an integer between 0 and 64 MiB"
                                        : "res.collectBody(maxSize, handler) maxSize must be an "
                                          "integer between 0 and 64 MiB");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    if (state->HasDataHandler()) {
        ThrowError(args.GetIsolate(),
                   returnBodyLength
                       ? "res.collectBodyWithLength() body handler is already registered"
                       : "res.collectBody() body handler is already registered");
        return;
    }
    state->RegisterDataHandler(args[1].As<Function>());

    struct Collection {
        std::vector<char> bytes;
        bool completed = false;
    };
    auto collection = std::make_shared<Collection>();
    const std::size_t maxSize = static_cast<std::size_t>(maxSizeNumber);

    state->Response()->onDataV2([state, collection, maxSize](std::string_view chunk,
                                                             uint64_t maxRemainingBodyLength) {
        if (!state->IsValid() || !state->HasActiveDataHandler() || collection->completed) {
            return;
        }

        Isolate *callbackIsolate = state->Isolate();
        HandleScope scope(callbackIsolate);
        if (collection->bytes.size() > maxSize ||
            chunk.size() > maxSize - collection->bytes.size()) {
            collection->completed = true;
            Local<Value> argv[] = {Null(callbackIsolate)};
            const bool callbackSucceeded = CallJs(callbackIsolate, state->DataHandler(), 1, argv);
            state->ResetDataHandler();
            if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
            return;
        }

        collection->bytes.insert(collection->bytes.end(), chunk.begin(), chunk.end());
        if (maxRemainingBodyLength != 0) return;

        collection->completed = true;
        auto *owned = new std::vector<char>(std::move(collection->bytes));
        if (owned->empty()) {
            delete owned;
            Local<ArrayBuffer> body = ArrayBuffer::New(callbackIsolate, 0);
            Local<Value> argv[] = {body};
            const bool callbackSucceeded = CallJs(callbackIsolate, state->DataHandler(), 1, argv);
            state->ResetDataHandler();
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
        const bool callbackSucceeded = CallJs(callbackIsolate, state->DataHandler(), 1, argv);
        state->ResetDataHandler();
        if (!callbackSucceeded) CloseAsyncResponseAfterCallbackFailure(state);
    });
    if (!returnBodyLength) {
        args.GetReturnValue().Set(args.This());
        return;
    }

    if (!state->Response()->hasDeclaredBodyLength()) {
        args.GetReturnValue().Set(Undefined(isolate));
        return;
    }
    const uint64_t bodyLength = state->Response()->maxRemainingBodyLength();
    args.GetReturnValue().Set(Number::New(isolate, static_cast<double>(bodyLength)));
}

void ResponseCollectBody(const FunctionCallbackInfo<Value> &args) {
    ResponseCollectBodyImpl(args, false);
}

void ResponseCollectBodyWithLength(const FunctionCallbackInfo<Value> &args) {
    ResponseCollectBodyImpl(args, true);
}

void ResponseDiscardBody(const FunctionCallbackInfo<Value> &args) {
    if (!GetResponse(args)) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "res.discardBody() does not accept arguments");
        return;
    }

    std::shared_ptr<AsyncResponseState> state = PromoteResponse(args);
    state->ResetDataHandler();
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
    if (state->HasAbortedHandler()) {
        ThrowError(args.GetIsolate(), "res.onAborted() handler is already registered");
        return;
    }
    state->RegisterAbortedHandler(args[0].As<Function>());
    args.GetReturnValue().Set(args.This());
}

void InitializeResponseBinding(BindingEnvironment *context, Local<External> contextExternal) {
    Isolate *isolate = context->Isolate();
    Local<FunctionTemplate> response = FunctionTemplate::New(isolate);
    response->InstanceTemplate()->SetInternalFieldCount(3);
    SetPrototypeMethod(isolate, response, "end", ResponseEnd);
    SetPrototypeMethod(isolate, response, "endWithoutBody", ResponseEndWithoutBody);
    SetPrototypeMethod(isolate, response, "close", ResponseClose);
    SetPrototypeMethod(isolate, response, "endBatch", ResponseEndBatch);
    SetPrototypeMethod(isolate, response, "writeStatus", ResponseWriteStatus);
    SetPrototypeMethod(isolate, response, "writeHeader", ResponseWriteHeader, contextExternal);
    SetPrototypeMethod(isolate, response, "cork", ResponseCork);
    SetPrototypeMethod(isolate, response, "collect", ResponseCork);
    SetPrototypeMethod(isolate, response, "beginWrite", ResponseBeginWrite);
    SetPrototypeMethod(isolate, response, "write", ResponseWrite);
    SetPrototypeMethod(isolate, response, "tryEnd", ResponseTryEnd);
    SetPrototypeMethod(isolate, response, "onWritable", ResponseOnWritable);
    SetPrototypeMethod(isolate, response, "getWriteOffset", ResponseGetWriteOffset);
    SetPrototypeMethod(isolate, response, "getRemoteAddress", ResponseGetRemoteAddress);
    SetPrototypeMethod(isolate, response, "getRemoteAddressAsText", ResponseGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, response, "getRemotePort", ResponseGetRemotePort);
    SetPrototypeMethod(
        isolate, response, "getProxiedRemoteAddress", ResponseGetProxiedRemoteAddress);
    SetPrototypeMethod(
        isolate, response, "getProxiedRemoteAddressAsText", ResponseGetProxiedRemoteAddressAsText);
    SetPrototypeMethod(isolate, response, "getProxiedRemotePort", ResponseGetProxiedRemotePort);
    SetPrototypeMethod(isolate, response, "upgrade", ResponseUpgrade);
    SetPrototypeMethod(isolate, response, "onData", ResponseOnData);
    SetPrototypeMethod(isolate, response, "onDataV2", ResponseOnDataV2);
    SetPrototypeMethod(isolate, response, "collectBody", ResponseCollectBody);
    SetPrototypeMethod(isolate, response, "collectBodyWithLength", ResponseCollectBodyWithLength);
    SetPrototypeMethod(isolate, response, "discardBody", ResponseDiscardBody);
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
    context->SetResponseTemplate(responseTemplate);
}

} // namespace swm::binding
