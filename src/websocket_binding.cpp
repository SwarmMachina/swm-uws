#include "binding_internal.h"

namespace swm::binding {

constexpr unsigned int MAX_WEBSOCKET_PAYLOAD_LENGTH = 64U * 1024U * 1024U;

SocketState *GetSocketState(const FunctionCallbackInfo<Value> &args) {
    if (!HasBindingObjectKind(args.This(), BindingObjectKind::Socket, 1)) {
        ThrowTypeError(args.GetIsolate(), "WebSocket method called with incompatible receiver");
        return nullptr;
    }
    auto *state = static_cast<SocketState *>(GetInternalPointer(args.This()));
    if (!state || !state->Socket() || state->App().IsClosed()) {
        ThrowError(args.GetIsolate(), "WebSocket is no longer valid");
        return nullptr;
    }
    return state;
}

void FailSocketCallback(SocketState *state) {
    if (!state) return;
    state->MarkCallbackFailed();
    if (!state->Socket()) return;
    NativeWebSocket *socket = state->DetachSocket();
    if (state->HasObject()) {
        SetInternalPointer(state->Object(), nullptr);
    }
    state->RequestClose(socket);
}

void SocketSend(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 3 || (args.Length() > 1 && !args[1]->IsBoolean()) ||
        (args.Length() > 2 && !args[2]->IsBoolean())) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.send(message, isBinary, compress) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(), "ws.send(message) exceeds the native transport limit");
        return;
    }
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.send(message) expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(state->Socket()->send(
        message.View(), isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT, compress)));
}

void SocketSendFirstFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 3 || (args.Length() > 1 && !args[1]->IsBoolean()) ||
        (args.Length() > 2 && !args[2]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.sendFirstFragment(message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(),
                        "ws.sendFirstFragment(message) exceeds the native transport limit");
        return;
    }
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.sendFirstFragment(message) expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(static_cast<int>(state->Socket()->sendFirstFragment(
        message.View(), isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT, compress)));
}

void SocketSendFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 2 || (args.Length() > 1 && !args[1]->IsBoolean())) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.sendFragment(message, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(),
                        "ws.sendFragment(message) exceeds the native transport limit");
        return;
    }
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.sendFragment(message) expects a string or buffer");
        return;
    }
    const bool compress = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(
        static_cast<int>(state->Socket()->sendFragment(message.View(), compress)));
}

void SocketSendLastFragment(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 1 || args.Length() > 2 || (args.Length() > 1 && !args[1]->IsBoolean())) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.sendLastFragment(message, compress?) received invalid arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0]);
    if (message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(),
                        "ws.sendLastFragment(message) exceeds the native transport limit");
        return;
    }
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.sendLastFragment(message) expects a string or buffer");
        return;
    }
    const bool compress = args.Length() > 1 && args[1]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(
        static_cast<int>(state->Socket()->sendLastFragment(message.View(), compress)));
}

void SocketPing(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() > 1) {
        ThrowTypeError(args.GetIsolate(), "ws.ping(message?) received too many arguments");
        return;
    }
    NativeBytes message(args.GetIsolate(), args[0], true);
    if (message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(), "ws.ping(message) exceeds the native transport limit");
        return;
    }
    if (!message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.ping(message?) expects a string or buffer");
        return;
    }
    args.GetReturnValue().Set(
        static_cast<int>(state->Socket()->send(message.View(), uWS::OpCode::PING)));
}

void SocketPublish(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() < 2 || args.Length() > 4 || (args.Length() > 2 && !args[2]->IsBoolean()) ||
        (args.Length() > 3 && !args[3]->IsBoolean())) {
        ThrowTypeError(
            args.GetIsolate(),
            "ws.publish(topic, message, isBinary?, compress?) received invalid arguments");
        return;
    }
    NativeBytes topic(args.GetIsolate(), args[0]);
    NativeBytes message(args.GetIsolate(), args[1]);
    if (topic.IsTooLarge() || message.IsTooLarge()) {
        ThrowRangeError(args.GetIsolate(), "ws.publish() exceeds the native transport limit");
        return;
    }
    if (!topic.IsValid() || !message.IsValid()) {
        ThrowTypeError(args.GetIsolate(), "ws.publish() message expects a string or buffer");
        return;
    }
    const bool isBinary = args.Length() > 2 && args[2]->BooleanValue(args.GetIsolate());
    const bool compress = args.Length() > 3 && args[3]->BooleanValue(args.GetIsolate());
    args.GetReturnValue().Set(
        Boolean::New(args.GetIsolate(),
                     state->Socket()->publish(topic.View(),
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
    NativeWebSocket *socket = state->Socket();
    std::shared_ptr<SocketState> stateLifetime = socket->getUserData()->state;
    socket->cork([isolate, handler, &callbackSucceeded, &callbackException]() {
        callbackSucceeded = CallJsDirect(isolate, handler, 0, nullptr, callbackException);
    });
    if (!callbackSucceeded) {
        FailSocketCallback(stateLifetime.get());
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
    args.GetReturnValue().Set(
        Boolean::New(args.GetIsolate(), state->Socket()->isSubscribed(topic.View())));
}

void SocketGetTopics(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getTopics() does not accept arguments");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Array> topics = Array::New(isolate);
    std::uint32_t index = 0;
    bool succeeded = true;
    state->Socket()->iterateTopics(
        [isolate, context, topics, &index, &succeeded](std::string_view topic) {
            if (!succeeded) return;
            succeeded = topics->CreateDataProperty(context, index++, NewString(isolate, topic))
                            .FromMaybe(false);
        });
    if (!succeeded) return;
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
        CopyToArrayBuffer(args.GetIsolate(), state->Socket()->getRemoteAddress()));
}

void SocketGetRemoteAddressAsText(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getRemoteAddressAsText() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        CopyToArrayBuffer(args.GetIsolate(), state->Socket()->getRemoteAddressAsText()));
}

void SocketGetRemotePort(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getRemotePort() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(Number::New(args.GetIsolate(), state->Socket()->getRemotePort()));
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
        ThrowTypeError(args.GetIsolate(), "ws.end([code[, reason]]) expects a number and a string");
        return;
    }
    int code = 0;
    if (args.Length() > 0 && args[0]->IsNumber()) {
        const double numericCode =
            args[0]->NumberValue(args.GetIsolate()->GetCurrentContext()).FromMaybe(-1);
        if (!std::isfinite(numericCode) || std::floor(numericCode) != numericCode) {
            ThrowTypeError(args.GetIsolate(), "ws.end() code must be an integer");
            return;
        }
        if (numericCode < 0 || numericCode > 4999) {
            ThrowTypeError(args.GetIsolate(),
                           "ws.end() code must be 0 or a valid WebSocket close code");
            return;
        }
        code = static_cast<int>(numericCode);
    }
    if (!IsValidWebSocketCloseCode(code)) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.end() code must be 0 or a valid WebSocket close code");
        return;
    }
    Local<Value> reasonValue = String::Empty(args.GetIsolate());
    if (args.Length() > 1) reasonValue = args[1];
    NativeBytes reason(args.GetIsolate(), reasonValue);
    if (!reason.IsValid()) {
        ThrowTypeError(args.GetIsolate(),
                       "ws.end([code[, reason]]) reason expects a string or buffer");
        return;
    }
    if (code == 0 && !reason.View().empty()) {
        ThrowTypeError(args.GetIsolate(), "ws.end() reason requires a non-zero close code");
        return;
    }
    if (reason.View().length() > 123) {
        ThrowTypeError(args.GetIsolate(), "ws.end() reason must be at most 123 UTF-8 bytes");
        return;
    }
    NativeWebSocket *socket = state->DetachSocket();
    SetInternalPointer(args.This(), nullptr);
    socket->end(code, reason.View());
}

void SocketClose(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.close() does not accept arguments");
        return;
    }
    NativeWebSocket *socket = state->DetachSocket();
    SetInternalPointer(args.This(), nullptr);
    state->RequestClose(socket);
}

void SocketGetBufferedAmount(const FunctionCallbackInfo<Value> &args) {
    SocketState *state = GetSocketState(args);
    if (!state) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "ws.getBufferedAmount() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(
        Number::New(args.GetIsolate(), static_cast<double>(state->Socket()->getBufferedAmount())));
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
    args.GetReturnValue().Set(
        Boolean::New(args.GetIsolate(), state->Socket()->subscribe(topic.View())));
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
    args.GetReturnValue().Set(
        Boolean::New(args.GetIsolate(), state->Socket()->unsubscribe(topic.View())));
}

bool ReadUnsignedOption(Isolate *isolate,
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
        std::string message = "WebSocket " + std::string(name) + " must be an integer between " +
                              std::to_string(minimum) + " and " + std::to_string(maximum);
        ThrowTypeError(isolate, message.c_str());
        return false;
    }
    *target = static_cast<unsigned int>(number);
    return true;
}

bool ReadBooleanOption(Isolate *isolate, Local<Object> options, const char *name, bool *target) {
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

Global<Function> *
StoreOptionalHandler(Isolate *isolate,
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

[[nodiscard]] bool ReadOwnDescriptorField(Local<Context> currentContext,
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

[[nodiscard]] bool CopyOwnPropertyDescriptor(Local<Context> currentContext,
                                             Local<Object> source,
                                             Local<v8::Name> key,
                                             Local<Object> target) {
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
    if (!ReadOwnDescriptorField(currentContext, descriptorObject, "value", &hasValue, &value) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "writable", &hasWritable, &writable) ||
        !ReadOwnDescriptorField(currentContext, descriptorObject, "get", &hasGetter, &getter) ||
        !ReadOwnDescriptorField(currentContext, descriptorObject, "set", &hasSetter, &setter) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "enumerable", &hasEnumerable, &enumerable) ||
        !ReadOwnDescriptorField(
            currentContext, descriptorObject, "configurable", &hasConfigurable, &configurable)) {
        return false;
    }

    std::unique_ptr<PropertyDescriptor> descriptor;
    if (hasValue) {
        descriptor = std::make_unique<PropertyDescriptor>(
            value, hasWritable && writable->BooleanValue(currentContext->GetIsolate()));
    } else {
        Local<Value> getterValue = v8::Undefined(currentContext->GetIsolate());
        Local<Value> setterValue = v8::Undefined(currentContext->GetIsolate());
        if (hasGetter) getterValue = getter;
        if (hasSetter) setterValue = setter;
        descriptor = std::make_unique<PropertyDescriptor>(getterValue, setterValue);
    }
    if (hasEnumerable) {
        descriptor->set_enumerable(enumerable->BooleanValue(currentContext->GetIsolate()));
    }
    if (hasConfigurable) {
        descriptor->set_configurable(configurable->BooleanValue(currentContext->GetIsolate()));
    }
    return target->DefineProperty(currentContext, key, *descriptor).FromMaybe(false);
}

v8::MaybeLocal<Object>
EnsureSocketObject(BindingEnvironment *context, AppState &app, NativeWebSocket *socket) {
    Isolate *isolate = context->Isolate();
    std::shared_ptr<SocketState> state = socket->getUserData()->state;
    if (!state) {
        state = std::make_shared<SocketState>(isolate, app);
        socket->getUserData()->state = state;
    }
    if (state->CallbackFailed()) return {};
    const bool nativeClosed = us_socket_is_closed(0, reinterpret_cast<us_socket_t *>(socket));
    if (state->HasObject()) {
        if (nativeClosed) (void)state->DetachSocket();
        return state->Object();
    }
    if (nativeClosed) {
        (void)state->DetachSocket();
        return {};
    }
    state->AttachSocket(socket);
    auto fail = [&state]() -> v8::MaybeLocal<Object> {
        FailSocketCallback(state.get());
        return {};
    };
    Local<Object> object = context->CloneSocketTemplate();
    if (state->HasUserData()) {
        Local<Value> userData = state->UserData();
        if (userData->IsObject()) {
            Local<Object> source = userData.As<Object>();
            Local<Context> currentContext = isolate->GetCurrentContext();
            Local<Array> keys;
            if (!source
                     ->GetOwnPropertyNames(currentContext,
                                           v8::ALL_PROPERTIES,
                                           v8::KeyConversionMode::kConvertToString)
                     .ToLocal(&keys)) {
                return fail();
            }
            if (!state->Socket()) return fail();
            for (uint32_t index = 0; index < keys->Length(); index++) {
                Local<Value> keyValue;
                if (!keys->Get(currentContext, index).ToLocal(&keyValue) || !keyValue->IsName()) {
                    return fail();
                }
                Local<v8::Name> key = keyValue.As<v8::Name>();
                v8::Maybe<bool> bindingOwnsKey = object->Has(currentContext, key);
                if (bindingOwnsKey.IsNothing()) return fail();
                if (!state->Socket()) return fail();
                if (bindingOwnsKey.FromJust()) continue;
                if (!CopyOwnPropertyDescriptor(currentContext, source, key, object)) {
                    return fail();
                }
                if (!state->Socket()) return fail();
            }
        }
        state->ResetUserData();
    }
    if (!state->Socket()) return fail();
    SetInternalPointer(object, state.get());
    state->SetObject(object);
    return object;
}

void AppWs(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    auto *state = GetAppState(args);
    if (!state) return;
    if (state->IsClosed()) {
        ThrowError(isolate, "app.ws() cannot be called after app.close()");
        return;
    }
    if (state->IsInHttpRouteCallback()) {
        ThrowError(isolate, "app.ws() cannot be called from an active HTTP route callback");
        return;
    }
    if (args.Length() != 2 || !args[1]->IsObject()) {
        ThrowTypeError(isolate, "app.ws(path, behavior) expects a string and an object");
        return;
    }
    NativeBytes path(isolate, args[0]);
    if (!path.IsValid()) {
        ThrowTypeError(isolate, "app.ws(path, behavior) path expects a string or buffer");
        return;
    }
    const std::string pathString(path.View());
    Local<Object> options = args[1].As<Object>();
    uWS::App::WebSocketBehavior<PerSocketData> behavior;
    Local<Value> compression;
    if (!GetProperty(isolate, options, "compression", &compression)) return;
    if (!compression->IsUndefined() &&
        (!compression->IsNumber() ||
         !compression->StrictEquals(Number::New(isolate, uWS::DISABLED)))) {
        ThrowTypeError(isolate,
                       "WebSocket compression is disabled; only uWS.DISABLED is supported");
        return;
    }
    unsigned int idleTimeout = behavior.idleTimeout;
    unsigned int maxLifetime = behavior.maxLifetime;
    if (!ReadUnsignedOption(isolate,
                            options,
                            "maxPayloadLength",
                            1,
                            MAX_WEBSOCKET_PAYLOAD_LENGTH,
                            &behavior.maxPayloadLength) ||
        !ReadUnsignedOption(isolate, options, "idleTimeout", 0, 960, &idleTimeout) ||
        !ReadUnsignedOption(isolate,
                            options,
                            "maxBackpressure",
                            0,
                            std::numeric_limits<unsigned int>::max(),
                            &behavior.maxBackpressure) ||
        !ReadUnsignedOption(isolate, options, "maxLifetime", 0, 240, &maxLifetime) ||
        !ReadBooleanOption(
            isolate, options, "closeOnBackpressureLimit", &behavior.closeOnBackpressureLimit) ||
        !ReadBooleanOption(
            isolate, options, "resetIdleTimeoutOnSend", &behavior.resetIdleTimeoutOnSend) ||
        !ReadBooleanOption(
            isolate, options, "sendPingsAutomatically", &behavior.sendPingsAutomatically)) {
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
    Global<Function> *upgrade =
        StoreOptionalHandler(isolate, options, "upgrade", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *open =
        StoreOptionalHandler(isolate, options, "open", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *message =
        StoreOptionalHandler(isolate, options, "message", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *dropped =
        StoreOptionalHandler(isolate, options, "dropped", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *drain =
        StoreOptionalHandler(isolate, options, "drain", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *ping =
        StoreOptionalHandler(isolate, options, "ping", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *pong =
        StoreOptionalHandler(isolate, options, "pong", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *subscription =
        StoreOptionalHandler(isolate, options, "subscription", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    Global<Function> *close =
        StoreOptionalHandler(isolate, options, "close", &handlersValid, &pendingHandlers);
    if (!handlersValid) return;
    if (state->IsClosed()) {
        ThrowError(isolate, "app.ws() cannot be called after app.close()");
        return;
    }
    if (state->IsInHttpRouteCallback()) {
        ThrowError(isolate, "app.ws() cannot be called from an active HTTP route callback");
        return;
    }
    for (auto &handler : pendingHandlers) {
        state->OwnHandler(std::move(handler));
    }

    BindingEnvironment *context = &state->Environment();
    if (upgrade) {
        behavior.upgrade = [context, upgrade, state](HttpResponse *response,
                                                     uWS::HttpRequest *request,
                                                     us_socket_context_t *socketContext) {
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
            UpgradeContextScope upgradeContext(*context, response, socketContext);
            Local<Value> argv[] = {responseObject, requestObject, upgradeContext.Token()};
            const bool callbackSucceeded =
                CallJs(callbackIsolate, upgrade->Get(callbackIsolate), 3, argv);
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
            if (GetInternalPointer(responseObject) && !GetInternalPointer(responseObject, 1)) {
                InvalidateResponseObject(responseObject);
                response->close();
            } else if (!callbackSucceeded && GetInternalPointer(responseObject, 1)) {
                auto *async =
                    static_cast<AsyncResponseState *>(GetInternalPointer(responseObject, 1));
                CloseAsyncResponseAfterCallbackFailure(async->shared_from_this());
            }
        };
    }
    behavior.open = [context, open, state](NativeWebSocket *socket) {
        HttpRouteCallbackScope routeCallbackScope{*state};
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        if (open) {
            Local<Value> argv[] = {socketObject};
            if (!CallJs(callbackIsolate, open->Get(callbackIsolate), 1, argv)) {
                FailSocketCallback(socketState.get());
            }
        }
    };
    behavior.message = [context, message, state](
                           NativeWebSocket *socket, std::string_view payload, uWS::OpCode opcode) {
        if (!message) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        NativeCallbackScope callbackScope(*state, socketState);
        EphemeralArrayBuffer buffer(ExternalArrayBuffer(callbackIsolate, payload));
        Local<Value> argv[] = {socketObject,
                               buffer.Value(),
                               Boolean::New(callbackIsolate, opcode == uWS::OpCode::BINARY)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, message->Get(callbackIsolate), 3, argv);
        if (!callbackSucceeded) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.dropped = [context, dropped, state](
                           NativeWebSocket *socket, std::string_view payload, uWS::OpCode opcode) {
        if (!dropped) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        /* A dropped callback may publish re-entrantly and invalidate TopicTree storage. */
        EphemeralArrayBuffer buffer(CopyToArrayBuffer(callbackIsolate, payload));
        Local<Value> argv[] = {socketObject,
                               buffer.Value(),
                               Boolean::New(callbackIsolate, opcode == uWS::OpCode::BINARY)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, dropped->Get(callbackIsolate), 3, argv);
        if (!callbackSucceeded) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.drain = [context, drain, state](NativeWebSocket *socket) {
        if (!drain) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        Local<Value> argv[] = {socketObject};
        if (!CallJs(callbackIsolate, drain->Get(callbackIsolate), 1, argv)) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.ping = [context, ping, state](NativeWebSocket *socket, std::string_view payload) {
        if (!ping) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        NativeCallbackScope callbackScope(*state, socketState);
        EphemeralArrayBuffer buffer(ExternalArrayBuffer(callbackIsolate, payload));
        Local<Value> argv[] = {socketObject, buffer.Value()};
        const bool callbackSucceeded = CallJs(callbackIsolate, ping->Get(callbackIsolate), 2, argv);
        if (!callbackSucceeded) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.pong = [context, pong, state](NativeWebSocket *socket, std::string_view payload) {
        if (!pong) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        NativeCallbackScope callbackScope(*state, socketState);
        EphemeralArrayBuffer buffer(ExternalArrayBuffer(callbackIsolate, payload));
        Local<Value> argv[] = {socketObject, buffer.Value()};
        const bool callbackSucceeded = CallJs(callbackIsolate, pong->Get(callbackIsolate), 2, argv);
        if (!callbackSucceeded) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.subscription = [context, subscription, state](NativeWebSocket *socket,
                                                           std::string_view topic,
                                                           int newCount,
                                                           int oldCount) {
        if (!subscription) return;
        std::shared_ptr<SocketState> socketState = socket->getUserData()->state;
        if (socketState && socketState->CallbackFailed()) return;
        Isolate *callbackIsolate = context->Isolate();
        HandleScope scope(callbackIsolate);
        Local<Object> socketObject;
        if (!EnsureSocketObject(context, *state, socket).ToLocal(&socketObject)) {
            return;
        }
        socketState = socket->getUserData()->state;
        NativeCallbackScope callbackScope(*state, socketState);
        EphemeralArrayBuffer topicBuffer(ExternalArrayBuffer(callbackIsolate, topic));
        Local<Value> argv[] = {socketObject,
                               topicBuffer.Value(),
                               Number::New(callbackIsolate, newCount),
                               Number::New(callbackIsolate, oldCount)};
        const bool callbackSucceeded =
            CallJs(callbackIsolate, subscription->Get(callbackIsolate), 4, argv);
        if (!callbackSucceeded) {
            FailSocketCallback(socketState.get());
        }
    };
    behavior.close =
        [context, close, state](NativeWebSocket *socket, int code, std::string_view reason) {
            std::shared_ptr<SocketState> socketState = std::move(socket->getUserData()->state);
            if (!socketState) return;
            Isolate *callbackIsolate = context->Isolate();
            HandleScope scope(callbackIsolate);
            Local<Object> socketObject;
            const bool hasObject = socketState->HasObject();
            if (hasObject) {
                socketObject = socketState->Object();
                SetInternalPointer(socketObject, nullptr);
            }
            (void)socketState->DetachSocket();
            if (close && !socketState->CallbackFailed() && hasObject) {
                NativeCallbackScope callbackScope(*state, socketState);
                EphemeralArrayBuffer reasonBuffer(ExternalArrayBuffer(callbackIsolate, reason));
                Local<Value> argv[] = {
                    socketObject, Number::New(callbackIsolate, code), reasonBuffer.Value()};
                const bool callbackSucceeded =
                    CallJs(callbackIsolate, close->Get(callbackIsolate), 3, argv);
                if (!callbackSucceeded) socketState->MarkCallbackFailed();
            }
            socketState->ResetObject();
            socketState->ResetUserData();
        };

    state->NativeApp().ws<PerSocketData>(pathString, std::move(behavior));
    state->EnableWebSockets();
    args.GetReturnValue().Set(args.This());
}

void InitializeWebSocketBinding(BindingEnvironment *context, Local<External>) {
    Isolate *isolate = context->Isolate();
    Local<FunctionTemplate> socket = FunctionTemplate::New(isolate);
    socket->InstanceTemplate()->SetInternalFieldCount(2);
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
    SetPrototypeMethod(isolate, socket, "getRemoteAddressAsText", SocketGetRemoteAddressAsText);
    SetPrototypeMethod(isolate, socket, "getRemotePort", SocketGetRemotePort);
    SetPrototypeMethod(isolate, socket, "getUserData", SocketGetUserData);
    SetPrototypeMethod(isolate, socket, "subscribe", SocketSubscribe);
    SetPrototypeMethod(isolate, socket, "unsubscribe", SocketUnsubscribe);
    SetPrototypeMethod(isolate, socket, "isSubscribed", SocketIsSubscribed);
    SetPrototypeMethod(isolate, socket, "getTopics", SocketGetTopics);
    Local<Object> socketTemplate = socket->GetFunction(isolate->GetCurrentContext())
                                       .ToLocalChecked()
                                       ->NewInstance(isolate->GetCurrentContext())
                                       .ToLocalChecked();
    SetBindingObjectKind(socketTemplate, BindingObjectKind::Socket, 1);
    context->SetSocketTemplate(socketTemplate);
}

void InstallWebSocketAppMethods(Local<FunctionTemplate> app, Local<External> contextExternal) {
    auto *context = static_cast<BindingEnvironment *>(contextExternal->Value());
    SetPrototypeMethod(context->Isolate(), app, "ws", AppWs, contextExternal);
}

} // namespace swm::binding
