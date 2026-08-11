#include "binding_internal.h"

namespace swm::binding {

void RegisterHttpRoute(const FunctionCallbackInfo<Value> &args,
                       HttpMethod method,
                       const char *methodName) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 2 || !args[1]->IsFunction()) {
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
    Global<Function> *handlerPointer = state->OwnHandler(isolate, args[1].As<Function>());
    BindingEnvironment *context = &state->Environment();
    auto routeHandler = [context, handlerPointer](HttpResponse *response,
                                                  uWS::HttpRequest *request) {
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->CloneResponseTemplate();
        Local<Object> requestObject = context->CloneRequestTemplate();
        SetInternalPointer(responseObject, response, 0);
        SetInternalPointer(requestObject, request);
        Local<Value> argv[] = {responseObject, requestObject};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, handlerPointer->Get(callbackIsolate), 2, argv);
        SetInternalPointer(requestObject, nullptr);

        if (GetInternalPointer(responseObject)) {
            auto *async = static_cast<AsyncResponseState *>(GetInternalPointer(responseObject, 1));
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
        ThrowTypeError(args.GetIsolate(),
                       "app.publish topic and message expect strings or buffers");
        return;
    }
    if (!state->HasWebSockets()) {
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
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state || args.Length() != 1) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a topic");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    if (!topic.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "app.numSubscribers(topic) expects a string or buffer");
        return;
    }
    if (!state->HasWebSockets()) {
        args.GetReturnValue().Set(0);
        return;
    }
    args.GetReturnValue().Set(state->NativeApp().numSubscribers(topic.View()));
}

void AppListen(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    const bool portOnly = args.Length() >= 2 && args.Length() <= 3 && args[0]->IsNumber() &&
                          args[args.Length() - 1]->IsFunction();
    const bool withHost = args.Length() >= 3 && args.Length() <= 4 && !args[0]->IsNumber() &&
                          args[1]->IsNumber() && args[args.Length() - 1]->IsFunction();
    if (!state || (!portOnly && !withHost) ||
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
    Global<Function> *callbackPointer =
        state->OwnHandler(isolate, args[callbackIndex].As<Function>());
    bool callbackSucceeded = true;
    auto listener =
        [state, isolate, callbackPointer, &callbackSucceeded](us_listen_socket_t *socket) {
            state->TrackListenSocket(socket);
            HandleScope scope(isolate);
            Local<Value> socketValue = v8::False(isolate);
            if (socket) socketValue = External::New(isolate, socket);
            Local<Value> argv[] = {socketValue};
            callbackSucceeded = CallJs(isolate, callbackPointer->Get(isolate), 1, argv);
            if (!callbackSucceeded && socket) {
                state->CloseListenSocket(socket);
            }
        };
    if (withHost) {
        NativeBytes host(isolate, args[0]);
        if (!host.IsValid()) {
            ThrowTypeError(isolate, "app.listen() host expects a string or buffer");
            return;
        }
        state->NativeApp().listen(std::string(host.View()), port, options, std::move(listener));
    } else {
        state->NativeApp().listen(port, options, std::move(listener));
    }
    if (!callbackSucceeded) return;
    args.GetReturnValue().Set(args.This());
}

void AppListenUnix(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    const bool withoutOptions = args.Length() == 2 && args[0]->IsFunction();
    const bool withOptions = args.Length() == 3 && args[0]->IsNumber() && args[1]->IsFunction();
    if (!state || (!withoutOptions && !withOptions)) {
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
    Global<Function> *callbackPointer =
        state->OwnHandler(isolate, args[callbackIndex].As<Function>());
    bool callbackSucceeded = true;
    state->NativeApp().listen(
        options,
        [state, isolate, callbackPointer, &callbackSucceeded](us_listen_socket_t *socket) {
            state->TrackListenSocket(socket);
            HandleScope scope(isolate);
            Local<Value> socketValue = v8::False(isolate);
            if (socket) socketValue = External::New(isolate, socket);
            Local<Value> argv[] = {socketValue};
            callbackSucceeded = CallJs(isolate, callbackPointer->Get(isolate), 1, argv);
            if (!callbackSucceeded && socket) {
                state->CloseListenSocket(socket);
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
    Global<Function> *handlerPointer = state->OwnHandler(isolate, args[0].As<Function>());
    BindingEnvironment *context = &state->Environment();
    state->NativeApp().filter([context, handlerPointer](HttpResponse *response, int count) {
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> responseObject = context->CloneResponseTemplate();
        SetInternalPointer(responseObject, response, 0);
        Local<Value> argv[] = {responseObject, Number::New(callbackIsolate, count)};
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
    state->Close();
    args.GetReturnValue().Set(args.This());
}

void AppGetHttpTransportStats(const FunctionCallbackInfo<Value> &args) {
    auto *state = static_cast<AppState *>(GetInternalPointer(args.This()));
    if (!state) {
        ThrowError(args.GetIsolate(), "App is no longer valid");
        return;
    }
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "app.getHttpTransportStats() does not accept arguments");
        return;
    }
    const uWS::HttpTransportStats stats = state->NativeApp().getHttpTransportStats();
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
    bool optionHasMaxHeaderSize = false;
    bool headersTimeoutExplicit = false;
    bool keepAliveTimeoutExplicit = false;
    bool bodyIdleTimeoutExplicit = false;
    bool responseWriteTimeoutExplicit = false;

    Local<Object> http;
    if (args.Length() == 1 && !args[0]->IsUndefined()) {
        Local<Object> options = args[0].As<Object>();
        const Local<String> httpKey = NewString(isolate, "http");
        const bool hasHttp = options->HasOwnProperty(context, httpKey).FromMaybe(false);
        if (isolate->IsExecutionTerminating()) return std::nullopt;
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
        constexpr std::array<std::string_view, 7> allowedFields = {
            "maxHeaderSize",
            "maxHeaderCount",
            "headersTimeoutMs",
            "keepAliveTimeoutMs",
            "bodyIdleTimeoutMs",
            "minBodyRateBytesPerSec",
            "responseWriteTimeoutMs",
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

        auto readInteger = [&](const char *name,
                               std::uint64_t maximum,
                               std::uint64_t *output,
                               bool *present = nullptr) -> bool {
            Local<String> key = NewString(isolate, name);
            const bool has = http->HasOwnProperty(context, key).FromMaybe(false);
            if (isolate->IsExecutionTerminating()) return false;
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

        std::uint64_t parsed = 0;
        if (!readInteger("maxHeaderSize", 9007199254740991ULL, &parsed, &optionHasMaxHeaderSize)) {
            return std::nullopt;
        }
        if (optionHasMaxHeaderSize) maxHeaderSize = static_cast<std::size_t>(parsed);
        if (!readInteger("maxHeaderCount", uWS::MAX_HEADER_COUNT_CAPACITY, &parsed)) {
            return std::nullopt;
        }
        if (http->HasOwnProperty(context, NewString(isolate, "maxHeaderCount")).FromMaybe(false)) {
            maxHeaderCount = static_cast<std::uint16_t>(parsed);
        }
        if (!readInteger("headersTimeoutMs", UINT32_MAX, &parsed, &headersTimeoutExplicit)) {
            return std::nullopt;
        }
        if (headersTimeoutExplicit) {
            headersTimeoutMs = static_cast<std::uint32_t>(parsed);
        }
        if (!readInteger("keepAliveTimeoutMs", UINT32_MAX, &parsed, &keepAliveTimeoutExplicit)) {
            return std::nullopt;
        }
        if (keepAliveTimeoutExplicit) {
            keepAliveTimeoutMs = static_cast<std::uint32_t>(parsed);
        }
        if (!readInteger("bodyIdleTimeoutMs", UINT32_MAX, &parsed, &bodyIdleTimeoutExplicit)) {
            return std::nullopt;
        }
        if (bodyIdleTimeoutExplicit) {
            bodyIdleTimeoutMs = static_cast<std::uint32_t>(parsed);
        }

        const Local<String> rateKey = NewString(isolate, "minBodyRateBytesPerSec");
        const bool hasRate = http->HasOwnProperty(context, rateKey).FromMaybe(false);
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

        if (!readInteger(
                "responseWriteTimeoutMs", UINT32_MAX, &parsed, &responseWriteTimeoutExplicit)) {
            return std::nullopt;
        }
        if (responseWriteTimeoutExplicit) {
            responseWriteTimeoutMs = static_cast<std::uint32_t>(parsed);
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
                               "UWS_HTTP_MAX_HEADERS_SIZE must be a positive decimal safe integer");
                return std::nullopt;
            }
            const std::string_view text(environmentValue.data(), environmentValueSize);
            std::uint64_t parsed = 0;
            const std::from_chars_result result =
                std::from_chars(text.data(), text.data() + text.size(), parsed);
            if (text.empty() || result.ec != std::errc() ||
                result.ptr != text.data() + text.size() || parsed == 0 ||
                parsed > 9007199254740991ULL) {
                ThrowTypeError(isolate,
                               "UWS_HTTP_MAX_HEADERS_SIZE must be a positive decimal safe integer");
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
    auto nativeApp = std::make_unique<uWS::App>(uWS::SocketContextOptions{}, *transportConfig);
    if (nativeApp->constructorFailed()) {
        ThrowError(isolate, "App() could not create the native HTTP context");
        return;
    }
    AppState *statePointer =
        context->OwnApp(std::make_unique<AppState>(*context, std::move(nativeApp)));
    Local<Object> app =
        context->AppConstructor()->NewInstance(isolate->GetCurrentContext()).ToLocalChecked();
    SetInternalPointer(app, statePointer);
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
    auto *socket = static_cast<us_listen_socket_t *>(args[0].As<External>()->Value());
    if (!socket) return;
    auto *context = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    context->ForgetListenSocket(socket);
    us_listen_socket_close(0, socket);
}

void SocketLocalPort(const FunctionCallbackInfo<Value> &args) {
    if (args.Length() != 1 || !args[0]->IsExternal()) {
        ThrowTypeError(args.GetIsolate(),
                       "us_socket_local_port(socket) expects a socket or listen socket");
        return;
    }
    auto *socket = static_cast<us_socket_t *>(args[0].As<External>()->Value());
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), us_socket_local_port(0, socket)));
}

void InitializeAppBinding(BindingEnvironment *context,
                          Local<External> contextExternal,
                          Local<Object> exports) {
    Isolate *isolate = context->Isolate();
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
              FunctionTemplate::New(isolate, SocketLocalPort)
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
