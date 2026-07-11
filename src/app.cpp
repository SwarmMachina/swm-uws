#include "app.h"

#include <App.h>
#include <uv.h>

#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace {

using HttpResponse = uWS::HttpResponse<false>;

struct HttpResponseState {
    HttpResponse *response = nullptr;
    bool valid = false;
};

struct SocketState;

struct PerSocketData {
    SocketState *state = nullptr;
};

using NativeWebSocket = uWS::WebSocket<false, true, PerSocketData>;

struct SocketState {
    NativeWebSocket *socket = nullptr;
    bool valid = false;
    Napi::ObjectReference object;
};

struct MessageView {
    std::string owned;
    const char *data = nullptr;
    std::size_t length = 0;
    bool binaryByDefault = false;
};

Napi::FunctionReference appConstructor;

void ThrowTypeError(Napi::Env env, const char *message) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
}

HttpResponseState *GetValidHttpResponseState(const Napi::CallbackInfo &info) {
    auto *state = static_cast<HttpResponseState *>(info.Data());

    if (!state || !state->valid || !state->response) {
        Napi::Error::New(info.Env(), "HTTP response is no longer valid")
            .ThrowAsJavaScriptException();
        return nullptr;
    }

    return state;
}

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
    if (name.empty()) {
        return false;
    }

    for (unsigned char character : name) {
        if (!IsHttpTokenCharacter(character)) {
            return false;
        }
    }

    return true;
}

bool ContainsInvalidHeaderValueCharacter(std::string_view value) {
    for (unsigned char character : value) {
        if ((character < 0x20 && character != '\t') || character == 0x7f) {
            return true;
        }
    }

    return false;
}

bool IsValidStatus(std::string_view status) {
    if (status.length() < 3 || status[0] < '1' || status[0] > '9' ||
        status[1] < '0' || status[1] > '9' || status[2] < '0' || status[2] > '9') {
        return false;
    }

    if (status.length() > 3 && status[3] != ' ') {
        return false;
    }

    return !ContainsInvalidHeaderValueCharacter(status);
}

Napi::Value ResponseWriteStatus(const Napi::CallbackInfo &info) {
    HttpResponseState *state = GetValidHttpResponseState(info);

    if (!state) {
        return info.Env().Undefined();
    }

    if (info.Length() != 1 || !info[0].IsString()) {
        ThrowTypeError(info.Env(), "res.writeStatus(status) expects a string");
        return info.Env().Undefined();
    }

    std::string status = info[0].As<Napi::String>().Utf8Value();

    if (!IsValidStatus(status)) {
        ThrowTypeError(info.Env(), "res.writeStatus(status) expects a three-digit status without control characters");
        return info.Env().Undefined();
    }

    state->response->writeStatus(status);
    return info.This();
}

Napi::Value ResponseWriteHeader(const Napi::CallbackInfo &info) {
    HttpResponseState *state = GetValidHttpResponseState(info);

    if (!state) {
        return info.Env().Undefined();
    }

    if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) {
        ThrowTypeError(info.Env(), "res.writeHeader(name, value) expects two strings");
        return info.Env().Undefined();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    std::string value = info[1].As<Napi::String>().Utf8Value();

    if (!IsValidHeaderName(name)) {
        ThrowTypeError(info.Env(), "res.writeHeader(name, value) expects a valid HTTP header name");
        return info.Env().Undefined();
    }

    if (ContainsInvalidHeaderValueCharacter(value)) {
        ThrowTypeError(info.Env(), "res.writeHeader(name, value) does not allow control characters in value");
        return info.Env().Undefined();
    }

    state->response->writeHeader(name, value);
    return info.This();
}

Napi::Value ResponseEnd(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    HttpResponseState *state = GetValidHttpResponseState(info);

    if (!state) {
        return env.Undefined();
    }

    if (info.Length() > 0 && !info[0].IsUndefined() && !info[0].IsString()) {
        ThrowTypeError(env, "res.end(body) expects a string");
        return env.Undefined();
    }

    std::string body;

    if (info.Length() > 0 && info[0].IsString()) {
        body = info[0].As<Napi::String>().Utf8Value();
    }

    state->response->end(body);
    state->response = nullptr;
    state->valid = false;
    return info.This();
}

Napi::Object CreateResponseObject(Napi::Env env, HttpResponse *response, HttpResponseState **stateOut) {
    auto *state = new HttpResponseState{response, true};
    Napi::Object object = Napi::Object::New(env);
    Napi::External<HttpResponseState> external = Napi::External<HttpResponseState>::New(
        env,
        state,
        [](Napi::Env, HttpResponseState *value) {
            delete value;
        });

    object.Set(Napi::Symbol::New(env, "swm.http-response-state"), external);
    object.Set("writeStatus", Napi::Function::New(env, ResponseWriteStatus, "writeStatus", state));
    object.Set("writeHeader", Napi::Function::New(env, ResponseWriteHeader, "writeHeader", state));
    object.Set("end", Napi::Function::New(env, ResponseEnd, "end", state));
    *stateOut = state;
    return object;
}

Napi::ArrayBuffer CopyToArrayBuffer(Napi::Env env, std::string_view value) {
    Napi::ArrayBuffer buffer = Napi::ArrayBuffer::New(env, value.length());

    if (!value.empty()) {
        std::memcpy(buffer.Data(), value.data(), value.length());
    }

    return buffer;
}

bool ReadMessage(const Napi::Value &value, MessageView *message) {
    if (value.IsString()) {
        message->owned = value.As<Napi::String>().Utf8Value();
        message->data = message->owned.data();
        message->length = message->owned.length();
        message->binaryByDefault = false;
        return true;
    }

    if (value.IsBuffer()) {
        Napi::Buffer<unsigned char> buffer = value.As<Napi::Buffer<unsigned char>>();
        message->data = reinterpret_cast<const char *>(buffer.Data());
        message->length = buffer.Length();
        message->binaryByDefault = true;
        return true;
    }

    if (value.IsArrayBuffer()) {
        Napi::ArrayBuffer buffer = value.As<Napi::ArrayBuffer>();
        message->data = static_cast<const char *>(buffer.Data());
        message->length = buffer.ByteLength();
        message->binaryByDefault = true;
        return true;
    }

    if (value.IsTypedArray()) {
        Napi::TypedArray array = value.As<Napi::TypedArray>();
        Napi::ArrayBuffer buffer = array.ArrayBuffer();
        message->data = static_cast<const char *>(buffer.Data()) + array.ByteOffset();
        message->length = array.ByteLength();
        message->binaryByDefault = true;
        return true;
    }

    return false;
}

Napi::Value SocketSend(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    auto *state = static_cast<SocketState *>(info.Data());

    if (!state || !state->valid || !state->socket) {
        Napi::Error::New(env, "WebSocket is no longer valid").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1) {
        ThrowTypeError(env, "ws.send(message[, isBinary]) requires a message");
        return env.Undefined();
    }

    MessageView message;

    if (!ReadMessage(info[0], &message)) {
        ThrowTypeError(env, "ws.send(message) expects a string, Buffer, ArrayBuffer, or TypedArray");
        return env.Undefined();
    }

    bool isBinary = message.binaryByDefault;

    if (info.Length() > 1 && !info[1].IsUndefined()) {
        if (!info[1].IsBoolean()) {
            ThrowTypeError(env, "ws.send(message, isBinary) expects a boolean isBinary flag");
            return env.Undefined();
        }

        isBinary = info[1].As<Napi::Boolean>().Value();
    }

    NativeWebSocket::SendStatus status = state->socket->send(
        std::string_view(message.data, message.length),
        isBinary ? uWS::OpCode::BINARY : uWS::OpCode::TEXT,
        false);

    return Napi::Number::New(env, static_cast<int>(status));
}

Napi::Object CreateSocketObject(Napi::Env env, NativeWebSocket *socket, SocketState **stateOut) {
    auto *state = new SocketState;
    state->socket = socket;
    state->valid = true;

    Napi::Object object = Napi::Object::New(env);
    Napi::External<SocketState> external = Napi::External<SocketState>::New(
        env,
        state,
        [](Napi::Env, SocketState *value) {
            delete value;
        });

    object.Set(Napi::Symbol::New(env, "swm.websocket-state"), external);
    object.Set("send", Napi::Function::New(env, SocketSend, "send", state));
    state->object = Napi::Persistent(object);
    *stateOut = state;
    return object;
}

class AppWrap : public Napi::ObjectWrap<AppWrap> {
public:
    explicit AppWrap(const Napi::CallbackInfo &info)
        : Napi::ObjectWrap<AppWrap>(info), env_(info.Env()) {
        uv_loop_t *loop = nullptr;
        napi_status status = napi_get_uv_event_loop(info.Env(), &loop);

        if (status != napi_ok || !loop) {
            Napi::Error::New(info.Env(), "Unable to access Node.js libuv event loop")
                .ThrowAsJavaScriptException();
            return;
        }

        uWS::Loop::get(loop);
        app_ = std::make_unique<uWS::App>();
    }

    ~AppWrap() override {
        app_.reset();
    }

    static Napi::Function Define(Napi::Env env) {
        return DefineClass(
            env,
            "SwmUwsApp",
            {
                InstanceMethod("get", &AppWrap::Get),
                InstanceMethod("ws", &AppWrap::Ws),
                InstanceMethod("listen", &AppWrap::Listen),
                InstanceMethod("close", &AppWrap::Close),
            });
    }

private:
    enum class Lifecycle {
        Created,
        Listening,
        Closed,
    };

    Napi::FunctionReference *StoreFunction(const Napi::Value &value) {
        auto reference = std::make_unique<Napi::FunctionReference>(
            Napi::Persistent(value.As<Napi::Function>()));
        Napi::FunctionReference *result = reference.get();
        handlers_.push_back(std::move(reference));
        return result;
    }

    Napi::Value Get(const Napi::CallbackInfo &info) {
        Napi::Env env = info.Env();

        if (!app_) {
            Napi::Error::New(env, "Native app is not initialized").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsFunction()) {
            ThrowTypeError(env, "app.get(path, handler) expects a string and a function");
            return env.Undefined();
        }

        std::string path = info[0].As<Napi::String>().Utf8Value();
        Napi::FunctionReference *handler = StoreFunction(info[1]);

        app_->get(path, [this, handler](HttpResponse *response, uWS::HttpRequest *) {
            Napi::Env env(env_);
            Napi::HandleScope scope(env);
            HttpResponseState *state = nullptr;
            Napi::Object responseObject = CreateResponseObject(env, response, &state);
            Napi::Object requestObject = Napi::Object::New(env);

            handler->Call({responseObject, requestObject});

            if (state->valid && state->response) {
                state->response->close();
                state->response = nullptr;
                state->valid = false;
            }
        });

        return info.This();
    }

    Napi::Value Ws(const Napi::CallbackInfo &info) {
        Napi::Env env = info.Env();

        if (!app_) {
            Napi::Error::New(env, "Native app is not initialized").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (info.Length() != 2 || !info[0].IsString() || !info[1].IsObject()) {
            ThrowTypeError(env, "app.ws(path, behavior) expects a string and an object");
            return env.Undefined();
        }

        std::string path = info[0].As<Napi::String>().Utf8Value();
        Napi::Object options = info[1].As<Napi::Object>();
        Napi::Value openValue = options.Get("open");
        Napi::Value messageValue = options.Get("message");
        Napi::Value closeValue = options.Get("close");

        if ((!openValue.IsUndefined() && !openValue.IsFunction()) ||
            (!messageValue.IsUndefined() && !messageValue.IsFunction()) ||
            (!closeValue.IsUndefined() && !closeValue.IsFunction())) {
            ThrowTypeError(env, "WebSocket open, message, and close handlers must be functions");
            return env.Undefined();
        }

        Napi::FunctionReference *openHandler =
            openValue.IsFunction() ? StoreFunction(openValue) : nullptr;
        Napi::FunctionReference *messageHandler =
            messageValue.IsFunction() ? StoreFunction(messageValue) : nullptr;
        Napi::FunctionReference *closeHandler =
            closeValue.IsFunction() ? StoreFunction(closeValue) : nullptr;

        uWS::App::WebSocketBehavior<PerSocketData> behavior;
        behavior.open = [this, openHandler](NativeWebSocket *socket) {
            Napi::Env env(env_);
            Napi::HandleScope scope(env);
            SocketState *state = nullptr;
            Napi::Object socketObject = CreateSocketObject(env, socket, &state);
            socket->getUserData()->state = state;
            activeSockets_++;

            if (openHandler) {
                openHandler->Call({socketObject});
            }
        };
        behavior.message = [this, messageHandler](
                               NativeWebSocket *socket,
                               std::string_view message,
                               uWS::OpCode opcode) {
            if (!messageHandler) {
                return;
            }

            SocketState *state = socket->getUserData()->state;

            if (!state || !state->valid) {
                return;
            }

            Napi::Env env(env_);
            Napi::HandleScope scope(env);
            Napi::ArrayBuffer copy = CopyToArrayBuffer(env, message);
            bool isBinary = opcode == uWS::OpCode::BINARY;
            messageHandler->Call(
                {state->object.Value(), copy, Napi::Boolean::New(env, isBinary)});
        };
        behavior.close = [this, closeHandler](
                             NativeWebSocket *socket,
                             int code,
                             std::string_view reason) {
            SocketState *state = socket->getUserData()->state;

            if (!state) {
                return;
            }

            Napi::Env env(env_);
            Napi::HandleScope scope(env);
            Napi::Object socketObject = state->object.Value();
            state->socket = nullptr;
            state->valid = false;
            socket->getUserData()->state = nullptr;

            if (closeHandler) {
                closeHandler->Call(
                    {socketObject, Napi::Number::New(env, code), CopyToArrayBuffer(env, reason)});
            }

            state->object.Reset();
            activeSockets_--;
            ReleaseSelfReferenceIfClosed();
        };

        app_->ws<PerSocketData>(path, std::move(behavior));
        return info.This();
    }

    Napi::Value Listen(const Napi::CallbackInfo &info) {
        Napi::Env env = info.Env();

        if (!app_) {
            Napi::Error::New(env, "Native app is not initialized").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (lifecycle_ == Lifecycle::Listening) {
            Napi::Error::New(env, "app.listen() has already succeeded")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (lifecycle_ == Lifecycle::Closed) {
            Napi::Error::New(env, "app.listen() cannot be called after app.close()")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (info.Length() != 3 || !info[0].IsString() || !info[1].IsNumber() ||
            !info[2].IsFunction()) {
            ThrowTypeError(env, "app.listen(host, port, callback) expects string, number, function");
            return env.Undefined();
        }

        std::string host = info[0].As<Napi::String>().Utf8Value();
        int port = info[1].As<Napi::Number>().Int32Value();

        if (port < 1 || port > 65535) {
            ThrowTypeError(env, "app.listen() port must be between 1 and 65535");
            return env.Undefined();
        }

        Napi::FunctionReference *callback = StoreFunction(info[2]);

        app_->listen(host, port, [this, callback](us_listen_socket_t *socket) {
            Napi::Env env(env_);

            if (socket && lifecycle_ == Lifecycle::Created) {
                listenSocket_ = socket;
                lifecycle_ = Lifecycle::Listening;
                Ref();
                selfReferenced_ = true;
            }

            callback->Call({Napi::Boolean::New(env, socket != nullptr)});
        });

        return info.This();
    }

    Napi::Value Close(const Napi::CallbackInfo &info) {
        if (info.Length() != 0) {
            ThrowTypeError(info.Env(), "app.close() does not accept arguments");
            return info.Env().Undefined();
        }

        if (lifecycle_ == Lifecycle::Closed) {
            return info.This();
        }

        lifecycle_ = Lifecycle::Closed;

        if (listenSocket_) {
            us_listen_socket_close(0, listenSocket_);
            listenSocket_ = nullptr;
        }

        ReleaseSelfReferenceIfClosed();
        return info.This();
    }

    void ReleaseSelfReferenceIfClosed() {
        if (lifecycle_ == Lifecycle::Closed && activeSockets_ == 0 && selfReferenced_) {
            selfReferenced_ = false;
            Unref();
        }
    }

    napi_env env_;
    std::unique_ptr<uWS::App> app_;
    std::vector<std::unique_ptr<Napi::FunctionReference>> handlers_;
    us_listen_socket_t *listenSocket_ = nullptr;
    std::size_t activeSockets_ = 0;
    Lifecycle lifecycle_ = Lifecycle::Created;
    bool selfReferenced_ = false;
};

Napi::Value CreateApp(const Napi::CallbackInfo &info) {
    return appConstructor.New({});
}

}  // namespace

void InitApp(Napi::Env env, Napi::Object exports) {
    appConstructor = Napi::Persistent(AppWrap::Define(env));
    appConstructor.SuppressDestruct();
    exports.Set("createApp", Napi::Function::New(env, CreateApp, "createApp"));
}
