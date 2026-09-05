#include "binding_internal.h"
#include "listen_socket_handle.h"

namespace swm::binding {

constexpr std::uint64_t MAX_HTTP_HEADER_SIZE = 64ULL * 1024ULL * 1024ULL;

void RegisterHttpRoute(const FunctionCallbackInfo<Value> &args,
                       HttpMethod method,
                       const char *methodName) {
    Isolate *isolate = args.GetIsolate();
    auto *state = GetAppState(args);
    if (!state) return;
    if (state->IsClosed()) {
        ThrowError(isolate, "app routes cannot be registered after app.close()");
        return;
    }
    if (state->IsInHttpRouteCallback()) {
        ThrowError(isolate, "app routes cannot be registered from an active HTTP route callback");
        return;
    }
    if (args.Length() != 2 || !args[1]->IsFunction()) {
        std::string message =
            "app." + std::string(methodName) + "(path, handler) expects a string and a function";
        ThrowTypeError(isolate, message.c_str());
        return;
    }

    NativeBytes path(isolate, args[0]);
    if (!path.IsValid()) {
        ThrowTypeError(isolate, "app route path expects a string or buffer");
        return;
    }
    auto handlerPointer = std::make_shared<Global<Function>>(isolate, args[1].As<Function>());
    BindingEnvironment *context = &state->Environment();
    auto routeHandler = [context, handlerPointer, state](HttpResponse *response,
                                                         uWS::HttpRequest *request) {
        HttpRouteCallbackScope routeCallbackScope{*state};
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->CloneResponseTemplate();
        Local<Object> requestObject = context->CloneRequestTemplate();
        ResponseCallbackLifetime callbackLifetime{state};
        ResponseMetadata responseMetadata{state, &callbackLifetime};
        SetInternalPointer(responseObject, response, 0);
        SetInternalPointer(responseObject, &responseMetadata, 2);
        SetInternalPointer(requestObject, request);
        SetInternalPointer(requestObject, &callbackLifetime, 2);
        Local<Value> argv[] = {responseObject, requestObject};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        callbackLifetime.Invalidate();
        SetInternalPointer(requestObject, nullptr);
        SetInternalPointer(requestObject, nullptr, 2);
        if (ResponseMetadata *metadata = GetResponseMetadata(responseObject)) {
            metadata->callbackLifetime = nullptr;
        }

        if (state->IsClosed()) {
            InvalidateResponseState(responseObject);
            return;
        }

        if (GetInternalPointer(responseObject)) {
            if (callbackSucceeded && request->getYield()) {
                InvalidateResponseState(responseObject);
                response->onAborted(nullptr);
                response->onWritable(nullptr);
                response->onDataV2(nullptr);
                return;
            }
            auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(responseObject, 1));
            if (!callbackSucceeded && async) {
                CloseAsyncResponseAfterCallbackFailure(async->shared_from_this());
            } else if (!async) {
                InvalidateResponseObject(responseObject);
                response->close();
            }
        }
    };

    const std::string pathString(path.View());
    switch (method) {
    case HttpMethod::Get:
        state->NativeApp().get(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Post:
        state->NativeApp().post(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Put:
        state->NativeApp().put(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Patch:
        state->NativeApp().patch(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Delete:
        state->NativeApp().del(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Options:
        state->NativeApp().options(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Head:
        state->NativeApp().head(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Connect:
        state->NativeApp().connect(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Trace:
        state->NativeApp().trace(pathString, std::move(routeHandler));
        break;
    case HttpMethod::Any:
        state->NativeApp().any(pathString, std::move(routeHandler));
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

void AppPublish(const FunctionCallbackInfo<Value> &args) {
    auto *state = GetAppState(args);
    if (!state) return;
    if (args.Length() < 2 || args.Length() > 4 || (args.Length() > 2 && !args[2]->IsBoolean()) ||
        (args.Length() > 3 && !args[3]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "app.publish(topic, message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    NativeBytes message(args.GetIsolate(), args[1]);
    if (topic.IsTooLarge() || message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(), "app.publish() exceeds the native transport limit");
        return;
    }
    if (!topic.IsValid() || !message.IsValid()) {
        ThrowTypeError(args.GetIsolate(),
                       "app.publish topic and message expect strings or buffers");
        return;
    }
    if (state->IsClosed() || !state->HasWebSockets()) {
        args.GetReturnValue().Set(false);
        return;
    }
    const bool isBinary = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 3 && args[3]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(
        Boolean::New(args.GetIsolate(),
                     state->NativeApp().publish(topic.View(),
                                                message.View(),
                                                isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
                                                compress)));
}

void AppNumSubscribers(const FunctionCallbackInfo<Value> &args) {
    auto *state = GetAppState(args);
    if (!state) return;
    if (args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a topic");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a string or buffer");
        return;
    }
    if (state->IsClosed() || !state->HasWebSockets()) {
        args.GetReturnValue().Set(0);
        return;
    }
    args.GetReturnValue().Set(state->NativeApp().numSubscribers(topic.View()));
}

void AppListen(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = GetAppState(args);
    if (!state) return;
    const bool portOnly = args.Length() >= 2 && args.Length() <= 3 && args[0]->IsNumber() &&
                          args[args.Length() - 1]->IsFunction();
    const bool withHost = args.Length() >= 3 && args.Length() <= 4 && !args[0]->IsNumber() &&
                          args[1]->IsNumber() && args[args.Length() - 1]->IsFunction();
    if ((!portOnly && !withHost) ||
        (((portOnly && args.Length() == 3) || (withHost && args.Length() == 4)) &&
         !args[args.Length() - 2]->IsNumber())) {
        ThrowTypeError(isolate,
                       "app.listen() expects (port[, options], callback) or (host, port[, "
                       "options], callback)");
        return;
    }
    if (state->IsClosed()) {
        ThrowError(isolate, "app.listen() cannot be called after app.close()");
        return;
    }
    const int portIndex = withHost ? 1 : 0;
    const int callbackIndex = args.Length() - 1;
    const double portNumber =
        args[portIndex]->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
    if (!std::isfinite(portNumber) || std::floor(portNumber) != portNumber || portNumber < 0 ||
        portNumber > 65535) {
        ThrowTypeError(isolate, "app.listen() port must be between 0 and 65535");
        return;
    }
    const int port = static_cast<int>(portNumber);
    const bool hasOptions = callbackIndex - portIndex == 2;
    int options = LIBUS_LISTEN_DEFAULT;
    if (hasOptions) {
        const double optionsNumber =
            args[callbackIndex - 1]->NumberValue(isolate->GetCurrentContext()).FromMaybe(-1);
        if (!std::isfinite(optionsNumber) || std::floor(optionsNumber) != optionsNumber ||
            optionsNumber < 0 || optionsNumber > 1) {
            ThrowTypeError(isolate, "app.listen() options must be 0 or 1");
            return;
        }
        options = static_cast<int>(optionsNumber);
    }
    std::string host;
    if (withHost) {
        NativeBytes nativeHost(isolate, args[0]);
        if (!nativeHost.IsValid()) {
            ThrowTypeError(isolate, "app.listen() host expects a string or buffer");
            return;
        }
        host.assign(nativeHost.View());
    }
    Local<Function> callback = args[callbackIndex].As<Function>();
    bool callbackSucceeded = true;
    auto listener = [state, isolate, callback, &callbackSucceeded](us_listen_socket_t *socket) {
        ListenSocketHandle *handle = state->TrackListenSocket(socket);
        HandleScope scope(isolate);
        Local<Value> socketValue = v8::False(isolate);
        if (handle) socketValue = handle->Token();
        Local<Value> argv[] = {socketValue};
        callbackSucceeded = CallJs(isolate, callback, 1, argv);
        if (!callbackSucceeded && handle) {
            (void)state->CloseListenSocket(handle);
        }
    };
    if (withHost) {
        state->NativeApp().listen(host, port, options, std::move(listener));
    } else {
        state->NativeApp().listen(port, options, std::move(listener));
    }
    if (!callbackSucceeded) return;
    args.GetReturnValue().Set(args.This());
}

void AppListenUnix(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = GetAppState(args);
    if (!state) return;
    const bool withoutOptions = args.Length() == 2 && args[0]->IsFunction();
    const bool withOptions = args.Length() == 3 && args[0]->IsNumber() && args[1]->IsFunction();
    if (!withoutOptions && !withOptions) {
        ThrowTypeError(isolate,
                       "app.listen_unix() expects (callback, path) or (options, callback, path)");
        return;
    }
    if (state->IsClosed()) {
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
    Local<Function> callback = args[callbackIndex].As<Function>();
    bool callbackSucceeded = true;
    state->NativeApp().listen(
        options,
        [state, isolate, callback, &callbackSucceeded](us_listen_socket_t *socket) {
            ListenSocketHandle *handle = state->TrackListenSocket(socket);
            HandleScope scope(isolate);
            Local<Value> socketValue = v8::False(isolate);
            if (handle) socketValue = handle->Token();
            Local<Value> argv[] = {socketValue};
            callbackSucceeded = CallJs(isolate, callback, 1, argv);
            if (!callbackSucceeded && handle) {
                (void)state->CloseListenSocket(handle);
            }
        },
        std::string(path.View()));
    if (!callbackSucceeded) return;
    args.GetReturnValue().Set(args.This());
}

void AppFilter(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = GetAppState(args);
    if (!state) return;
    if (state->IsClosed()) {
        ThrowError(isolate, "app.filter() cannot be called after app.close()");
        return;
    }
    if (state->IsInFilterCallback()) {
        ThrowError(isolate, "app.filter() cannot be called from a filter callback");
        return;
    }
    if (args.Length() != 1 || !args[0]->IsFunction()) {
        ThrowTypeError(isolate, "app.filter(handler) expects a function");
        return;
    }
    auto handlerPointer = std::make_shared<Global<Function>>(isolate, args[0].As<Function>());
    BindingEnvironment *context = &state->Environment();
    state->NativeApp().filter([context, handlerPointer, state](HttpResponse *response, int count) {
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->CloneResponseTemplate();
        ResponseMetadata responseMetadata{state};
        responseMetadata.readOnly = count < 0;
        SetInternalPointer(responseObject, response, 0);
        SetInternalPointer(responseObject, &responseMetadata, 2);
        Local<Value> argv[] = {responseObject, Number::New(callbackIsolate, count)};
        state->EnterFilterCallback();
        const bool callbackSucceeded =
            CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        state->LeaveFilterCallback();
        const bool responseWasValid = GetInternalPointer(responseObject);
        InvalidateResponseState(responseObject);
        if (state->IsClosed()) {
            return;
        }
        if (!callbackSucceeded && count > 0 && responseWasValid) {
            response->close();
        }
    });
    args.GetReturnValue().Set(args.This());
}

void AppClose(const FunctionCallbackInfo<Value> &args) {
    auto *state = GetAppState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "app.close() does not accept arguments");
        return;
    }
    state->Close();
    args.GetReturnValue().Set(args.This());
}

void AppGetHttpTransportStats(const FunctionCallbackInfo<Value> &args) {
    auto *state = GetAppState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "app.getHttpTransportStats() does not accept arguments");
        return;
    }
    const uWS::HttpTransportStats stats = state->TransportStats();
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Object> result = Object::New(isolate);
    const std::pair<const char *, std::uint64_t> fields[] = {
        {"activeConnections", stats.activeConnections},
        {"headerTooLarge", stats.headerTooLarge},
        {"headerCountExceeded", stats.headerCountExceeded},
        {"headerTimeouts", stats.headerTimeouts},
        {"bodyTimeouts", stats.bodyTimeouts},
        {"bodyRateViolations", stats.bodyRateViolations},
        {"responseWriteTimeouts", stats.responseWriteTimeouts},
    };
    for (const auto &[name, value] : fields) {
        if (!result
                 ->CreateDataProperty(context,
                                      NewString(isolate, name),
                                      Number::New(isolate, static_cast<double>(value)))
                 .FromMaybe(false)) {
            return;
        }
    }
    args.GetReturnValue().Set(result);
}

std::optional<uWS::HttpTransportConfig>
ParseHttpTransportConfig(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto hasOwnProperty =
        [context](Local<Object> object, Local<v8::Name> key, bool *result) -> bool {
        v8::Maybe<bool> has = object->HasOwnProperty(context, key);
        if (has.IsNothing()) return false;
        *result = has.FromJust();
        return true;
    };
    if (args.Length() > 1 || (args.Length() == 1 && !args[0]->IsUndefined() &&
                              (!args[0]->IsObject() || args[0]->IsNull() || args[0]->IsArray() ||
                               args[0]->IsFunction()))) {
        ThrowTypeError(isolate, "App(options?) expects an optional options object");
        return std::nullopt;
    }

    std::size_t maxHeaderSize = uWS::HttpTransportConfig::DEFAULT_MAX_HEADER_SIZE;
    std::uint16_t maxHeaderCount = uWS::HttpTransportConfig::DEFAULT_MAX_HEADER_COUNT;
    std::uint32_t headersTimeoutMs = uWS::HttpTransportConfig::DEFAULT_HEADERS_TIMEOUT_MS;
    std::uint32_t keepAliveTimeoutMs = uWS::HttpTransportConfig::DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
    std::uint32_t bodyIdleTimeoutMs = uWS::HttpTransportConfig::DEFAULT_BODY_IDLE_TIMEOUT_MS;
    std::optional<std::uint32_t> minBodyRateBytesPerSec =
        uWS::HttpTransportConfig::DEFAULT_MIN_BODY_RATE_BYTES_PER_SEC;
    std::uint32_t responseWriteTimeoutMs =
        uWS::HttpTransportConfig::DEFAULT_RESPONSE_WRITE_TIMEOUT_MS;
    uWS::TrustedProxyHeader trustedProxyHeader = uWS::TrustedProxyHeader::None;
    std::uint8_t trustedProxyHops = 1;
    bool optionHasMaxHeaderSize = false;
    bool headersTimeoutExplicit = false;
    bool keepAliveTimeoutExplicit = false;
    bool bodyIdleTimeoutExplicit = false;
    bool responseWriteTimeoutExplicit = false;

    Local<Object> http;
    if (args.Length() == 1 && !args[0]->IsUndefined()) {
        Local<Object> options = args[0].As<Object>();
        const Local<String> httpKey = NewString(isolate, "http");
        bool hasHttp = false;
        if (!hasOwnProperty(options, httpKey, &hasHttp)) return std::nullopt;
        if (hasHttp) {
            Local<Value> httpValue;
            if (!options->Get(context, httpKey).ToLocal(&httpValue)) {
                return std::nullopt;
            }
            if (!httpValue->IsUndefined()) {
                if (!httpValue->IsObject() || httpValue->IsNull() || httpValue->IsArray() ||
                    httpValue->IsFunction()) {
                    ThrowTypeError(isolate, "App options.http must be an object");
                    return std::nullopt;
                }
                http = httpValue.As<Object>();
            }
        }
    }

    if (!http.IsEmpty()) {
        constexpr std::array<std::string_view, 8> allowedFields = {
            "maxHeaderSize",
            "maxHeaderCount",
            "headersTimeoutMs",
            "keepAliveTimeoutMs",
            "bodyIdleTimeoutMs",
            "minBodyRateBytesPerSec",
            "responseWriteTimeoutMs",
            "trustedProxy",
        };
        Local<Array> propertyNames;
        if (!http->GetOwnPropertyNames(context).ToLocal(&propertyNames)) {
            return std::nullopt;
        }
        for (std::uint32_t index = 0; index < propertyNames->Length(); index++) {
            Local<Value> value;
            if (!propertyNames->Get(context, index).ToLocal(&value)) {
                return std::nullopt;
            }
            NativeBytes propertyName(isolate, value);
            if (!propertyName.IsValid() ||
                std::find(allowedFields.begin(), allowedFields.end(), propertyName.View()) ==
                    allowedFields.end()) {
                ThrowTypeError(isolate, "unknown field in App options.http");
                return std::nullopt;
            }
        }

        std::uint64_t parsed = 0;
        auto readInteger = [&](const char *name,
                               std::uint64_t maximum,
                               std::uint64_t *output,
                               bool *present = nullptr) -> bool {
            Local<String> key = NewString(isolate, name);
            bool has = false;
            if (!hasOwnProperty(http, key, &has)) return false;
            if (present) *present = has;
            if (!has) return true;
            Local<Value> value;
            if (!http->Get(context, key).ToLocal(&value)) return false;
            if (!value->IsNumber()) {
                ThrowTypeError(isolate, "HTTP transport values must be finite safe integers");
                return false;
            }
            const double number = value.As<Number>()->Value();
            if (!std::isfinite(number) || number <= 0 || number > 9007199254740991.0 ||
                std::floor(number) != number || number > static_cast<double>(maximum)) {
                ThrowTypeError(isolate,
                               "HTTP transport values must be positive finite safe integers within "
                               "native range");
                return false;
            }
            *output = static_cast<std::uint64_t>(number);
            return true;
        };

        auto readExplicitTimeout =
            [&](const char *name, std::uint32_t *timeoutMs, bool *isExplicit) -> bool {
            if (!readInteger(
                    name, uWS::HttpTransportConfig::MAX_EXPLICIT_TIMEOUT_MS, &parsed, isExplicit)) {
                return false;
            }
            if (*isExplicit) {
                *timeoutMs = static_cast<std::uint32_t>(parsed);
            }
            return true;
        };

        if (!readInteger("maxHeaderSize", MAX_HTTP_HEADER_SIZE, &parsed, &optionHasMaxHeaderSize)) {
            return std::nullopt;
        }
        if (optionHasMaxHeaderSize) maxHeaderSize = static_cast<std::size_t>(parsed);
        bool optionHasMaxHeaderCount = false;
        if (!readInteger("maxHeaderCount",
                         uWS::MAX_HEADER_COUNT_CAPACITY,
                         &parsed,
                         &optionHasMaxHeaderCount)) {
            return std::nullopt;
        }
        if (optionHasMaxHeaderCount) {
            maxHeaderCount = static_cast<std::uint16_t>(parsed);
        }
        if (!readExplicitTimeout("headersTimeoutMs", &headersTimeoutMs, &headersTimeoutExplicit)) {
            return std::nullopt;
        }
        if (!readExplicitTimeout(
                "keepAliveTimeoutMs", &keepAliveTimeoutMs, &keepAliveTimeoutExplicit)) {
            return std::nullopt;
        }
        if (!readExplicitTimeout(
                "bodyIdleTimeoutMs", &bodyIdleTimeoutMs, &bodyIdleTimeoutExplicit)) {
            return std::nullopt;
        }

        const Local<String> rateKey = NewString(isolate, "minBodyRateBytesPerSec");
        bool hasRate = false;
        if (!hasOwnProperty(http, rateKey, &hasRate)) return std::nullopt;
        if (hasRate) {
            Local<Value> value;
            if (!http->Get(context, rateKey).ToLocal(&value)) return std::nullopt;
            if (value->IsNull()) {
                minBodyRateBytesPerSec = std::nullopt;
            } else {
                if (!readInteger("minBodyRateBytesPerSec", UINT32_MAX, &parsed)) {
                    return std::nullopt;
                }
                minBodyRateBytesPerSec = static_cast<std::uint32_t>(parsed);
            }
        }

        if (!readExplicitTimeout(
                "responseWriteTimeoutMs", &responseWriteTimeoutMs, &responseWriteTimeoutExplicit)) {
            return std::nullopt;
        }

        const Local<String> trustedProxyKey = NewString(isolate, "trustedProxy");
        bool hasTrustedProxy = false;
        if (!hasOwnProperty(http, trustedProxyKey, &hasTrustedProxy)) return std::nullopt;
        if (hasTrustedProxy) {
            Local<Value> trustedProxyValue;
            if (!http->Get(context, trustedProxyKey).ToLocal(&trustedProxyValue)) {
                return std::nullopt;
            }
            if (!trustedProxyValue->IsObject() || trustedProxyValue->IsNull() ||
                trustedProxyValue->IsArray() || trustedProxyValue->IsFunction()) {
                ThrowTypeError(isolate, "HTTP trustedProxy must be an object");
                return std::nullopt;
            }

            Local<Object> trustedProxy = trustedProxyValue.As<Object>();
            constexpr std::array<std::string_view, 2> allowedTrustedProxyFields = {
                "header",
                "hops",
            };
            Local<Array> trustedProxyPropertyNames;
            if (!trustedProxy->GetOwnPropertyNames(context).ToLocal(&trustedProxyPropertyNames)) {
                return std::nullopt;
            }
            for (std::uint32_t index = 0; index < trustedProxyPropertyNames->Length(); index++) {
                Local<Value> value;
                if (!trustedProxyPropertyNames->Get(context, index).ToLocal(&value)) {
                    return std::nullopt;
                }
                NativeBytes propertyName(isolate, value);
                if (!propertyName.IsValid() ||
                    std::find(allowedTrustedProxyFields.begin(),
                              allowedTrustedProxyFields.end(),
                              propertyName.View()) == allowedTrustedProxyFields.end()) {
                    ThrowTypeError(isolate, "unknown field in HTTP trustedProxy");
                    return std::nullopt;
                }
            }

            const Local<String> headerKey = NewString(isolate, "header");
            bool hasHeader = false;
            if (!hasOwnProperty(trustedProxy, headerKey, &hasHeader)) return std::nullopt;
            if (!hasHeader) {
                ThrowTypeError(isolate, "HTTP trustedProxy.header is required");
                return std::nullopt;
            }
            Local<Value> headerValue;
            if (!trustedProxy->Get(context, headerKey).ToLocal(&headerValue)) {
                return std::nullopt;
            }
            if (!headerValue->IsString()) {
                ThrowTypeError(isolate,
                               "HTTP trustedProxy.header must be x-forwarded-for or x-real-ip");
                return std::nullopt;
            }
            NativeBytes header(isolate, headerValue);
            if (!header.IsValid()) return std::nullopt;
            if (header.View() == "x-forwarded-for") {
                trustedProxyHeader = uWS::TrustedProxyHeader::XForwardedFor;
            } else if (header.View() == "x-real-ip") {
                trustedProxyHeader = uWS::TrustedProxyHeader::XRealIp;
            } else {
                ThrowTypeError(isolate,
                               "HTTP trustedProxy.header must be x-forwarded-for or x-real-ip");
                return std::nullopt;
            }

            const Local<String> hopsKey = NewString(isolate, "hops");
            bool hasHops = false;
            if (!hasOwnProperty(trustedProxy, hopsKey, &hasHops)) return std::nullopt;
            if (hasHops) {
                Local<Value> hopsValue;
                if (!trustedProxy->Get(context, hopsKey).ToLocal(&hopsValue)) {
                    return std::nullopt;
                }
                if (!hopsValue->IsNumber()) {
                    ThrowTypeError(isolate,
                                   "HTTP trustedProxy.hops must be an integer between 1 and 32");
                    return std::nullopt;
                }
                const double hops = hopsValue.As<Number>()->Value();
                if (!std::isfinite(hops) || std::floor(hops) != hops || hops < 1 || hops > 32) {
                    ThrowTypeError(isolate,
                                   "HTTP trustedProxy.hops must be an integer between 1 and 32");
                    return std::nullopt;
                }
                trustedProxyHops = static_cast<std::uint8_t>(hops);
            }
            if (trustedProxyHeader == uWS::TrustedProxyHeader::XRealIp && trustedProxyHops != 1) {
                ThrowTypeError(isolate, "HTTP x-real-ip trustedProxy.hops must be 1");
                return std::nullopt;
            }
        }
    }

    if (!optionHasMaxHeaderSize) {
        std::array<char, 64> environmentValue{};
        std::size_t environmentValueSize = environmentValue.size();
        const int environmentStatus = uv_os_getenv(
            "UWS_HTTP_MAX_HEADERS_SIZE", environmentValue.data(), &environmentValueSize);
        if (environmentStatus != UV_ENOENT) {
            if (environmentStatus != 0) {
                ThrowTypeError(isolate,
                               "UWS_HTTP_MAX_HEADERS_SIZE must be a decimal integer between 1 and "
                               "67108864");
                return std::nullopt;
            }
            const std::string_view text(environmentValue.data(), environmentValueSize);
            std::uint64_t parsed = 0;
            const std::from_chars_result result =
                std::from_chars(text.data(), text.data() + text.size(), parsed);
            if (text.empty() || result.ec != std::errc() ||
                result.ptr != text.data() + text.size() || parsed == 0 ||
                parsed > MAX_HTTP_HEADER_SIZE) {
                ThrowTypeError(isolate,
                               "UWS_HTTP_MAX_HEADERS_SIZE must be a decimal integer between 1 and "
                               "67108864");
                return std::nullopt;
            }
            maxHeaderSize = static_cast<std::size_t>(parsed);
        }
    }

    return uWS::HttpTransportConfig(maxHeaderSize,
                                    maxHeaderCount,
                                    headersTimeoutMs,
                                    keepAliveTimeoutMs,
                                    bodyIdleTimeoutMs,
                                    minBodyRateBytesPerSec,
                                    responseWriteTimeoutMs,
                                    trustedProxyHeader,
                                    trustedProxyHops,
                                    headersTimeoutExplicit,
                                    keepAliveTimeoutExplicit,
                                    bodyIdleTimeoutExplicit,
                                    responseWriteTimeoutExplicit);
}

void CreateApp(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    std::optional<uWS::HttpTransportConfig> transportConfig = ParseHttpTransportConfig(args);
    if (!transportConfig) return;
    auto *context = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    if (context->IsClosing()) {
        ThrowError(isolate, "App cannot be created during environment cleanup");
        return;
    }
    auto nativeApp = std::make_unique<uWS::App>(uWS::SocketContextOptions{}, *transportConfig);
    if (nativeApp->constructorFailed()) {
        ThrowError(isolate, "App() could not create the native HTTP context");
        return;
    }
    AppState *statePointer =
        context->OwnApp(std::make_unique<AppState>(*context, std::move(nativeApp)));
    Local<Object> app =
        context->AppConstructor()->NewInstance(isolate->GetCurrentContext()).ToLocalChecked();
    statePointer->AttachObject(app);
    SetInternalPointer(app, statePointer);
    SetBindingObjectKind(app, BindingObjectKind::App, 1);
    args.GetReturnValue().Set(app);
}

void Version(const FunctionCallbackInfo<Value> &args) {
    args.GetReturnValue().Set(
        NewString(args.GetIsolate(), SWM_UWS_VERSION "+uWebSockets-" SWM_UWS_UPSTREAM_VERSION));
}

void Capabilities(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Object> result = Object::New(isolate);
    const char *names[] = {
        "beginWrite",
        "collectBody",
        "collectBodyLength",
        "httpTransportConfig",
        "preparedHeaders",
        "requestPrefetch",
        "responseBatch",
        "requestPause",
    };
    for (const char *name : names) {
        result->CreateDataProperty(context, NewString(isolate, name), Boolean::New(isolate, true))
            .ToChecked();
    }
    args.GetReturnValue().Set(result);
}

void CloseListenSocket(const FunctionCallbackInfo<Value> &args) {
    if (args.Length() != 1 || !args[0]->IsExternal()) {
        ThrowTypeError(args.GetIsolate(), "us_listen_socket_close(socket) expects a listen socket");
        return;
    }
    auto *context = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    if (!context->CloseListenSocket(args[0])) {
        ThrowTypeError(args.GetIsolate(),
                       "us_listen_socket_close(socket) expects a live listen socket");
    }
}

void SocketLocalPort(const FunctionCallbackInfo<Value> &args) {
    if (args.Length() != 1 || !args[0]->IsExternal()) {
        ThrowTypeError(args.GetIsolate(), "us_socket_local_port(socket) expects a listen socket");
        return;
    }
    auto *context = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    const std::optional<int> port = context->ListenSocketLocalPort(args[0]);
    if (!port) {
        ThrowTypeError(args.GetIsolate(),
                       "us_socket_local_port(socket) expects a live listen socket");
        return;
    }
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), *port));
}

void InitializeAppBinding(BindingEnvironment *context,
                          Local<External> contextExternal,
                          Local<Object> exports) {
    Isolate *isolate = context->Isolate();
    Local<FunctionTemplate> app = FunctionTemplate::New(isolate);
    app->InstanceTemplate()->SetInternalFieldCount(2);
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
    InstallWebSocketAppMethods(app, contextExternal);
    SetPrototypeMethod(isolate, app, "publish", AppPublish);
    SetPrototypeMethod(isolate, app, "numSubscribers", AppNumSubscribers);
    SetPrototypeMethod(isolate, app, "listen", AppListen);
    SetPrototypeMethod(isolate, app, "listen_unix", AppListenUnix);
    SetPrototypeMethod(isolate, app, "filter", AppFilter);
    SetPrototypeMethod(isolate, app, "getHttpTransportStats", AppGetHttpTransportStats);
    SetPrototypeMethod(isolate, app, "close", AppClose);
    context->SetAppConstructor(app->GetFunction(isolate->GetCurrentContext()).ToLocalChecked());

    Local<Function> createApp = FunctionTemplate::New(isolate, CreateApp, contextExternal)
                                    ->GetFunction(isolate->GetCurrentContext())
                                    .ToLocalChecked();
    exports->Set(isolate->GetCurrentContext(), NewString(isolate, "createApp"), createApp)
        .ToChecked();
    exports->Set(isolate->GetCurrentContext(), NewString(isolate, "App"), createApp).ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "RequestPrefetchPlan"),
              context->RequestPrefetchPlanConstructor())
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "version"),
              FunctionTemplate::New(isolate, Version)
                  ->GetFunction(isolate->GetCurrentContext())
                  .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "capabilities"),
              FunctionTemplate::New(isolate, Capabilities)
                  ->GetFunction(isolate->GetCurrentContext())
                  .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "us_listen_socket_close"),
              FunctionTemplate::New(isolate, CloseListenSocket, contextExternal)
                  ->GetFunction(isolate->GetCurrentContext())
                  .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "us_socket_local_port"),
              FunctionTemplate::New(isolate, SocketLocalPort, contextExternal)
                  ->GetFunction(isolate->GetCurrentContext())
                  .ToLocalChecked())
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "LIBUS_LISTEN_EXCLUSIVE_PORT"),
              Number::New(isolate, LIBUS_LISTEN_EXCLUSIVE_PORT))
        .ToChecked();
    exports
        ->Set(isolate->GetCurrentContext(),
              NewString(isolate, "DISABLED"),
              Number::New(isolate, uWS::CompressOptions::DISABLED))
        .ToChecked();
}

} // namespace swm::binding
