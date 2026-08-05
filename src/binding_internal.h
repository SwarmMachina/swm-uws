#ifndef SWM_UWS_BINDING_INTERNAL_H
#define SWM_UWS_BINDING_INTERNAL_H

#include <App.h>
#include <node.h>
#include <v8.h>

#include "app_state.h"
#include "async_response_state.h"
#include "binding_environment.h"
#include "native_bytes.h"
#include "request_prefetch_plan.h"
#include "request_prefetch_snapshot.h"
#include "socket_state.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace swm::binding {

using v8::Array;
using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::BigInt;
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
using v8::PropertyDescriptor;
using v8::SharedArrayBuffer;
using v8::String;
using v8::Value;

enum class HttpMethod : std::uint8_t {
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

struct ResponseMetadata {
    std::optional<uintmax_t> tryEndTotal;
    bool chunked = false;
};

inline void *GetInternalPointer(const Local<Object> &object, int index = 0) {
#if V8_MAJOR_VERSION == 14
    return object->GetAlignedPointerFromInternalField(index, 0);
#else
    return object->GetAlignedPointerFromInternalField(index);
#endif
}

inline void SetInternalPointer(const Local<Object> &object, void *pointer, int index = 0) {
#if V8_MAJOR_VERSION == 14
    object->SetAlignedPointerInInternalField(index, pointer, 0);
#else
    object->SetAlignedPointerInInternalField(index, pointer);
#endif
}

inline Local<String> NewString(Isolate *isolate, std::string_view value) {
    if (value.empty()) return String::Empty(isolate);
    return String::NewFromUtf8(
               isolate, value.data(), NewStringType::kNormal, static_cast<int>(value.length()))
        .ToLocalChecked();
}

inline Local<String> NewOneByteString(Isolate *isolate, std::string_view value) {
    if (value.empty()) return String::Empty(isolate);
    return String::NewFromOneByte(isolate,
                                  reinterpret_cast<const uint8_t *>(value.data()),
                                  NewStringType::kNormal,
                                  static_cast<int>(value.length()))
        .ToLocalChecked();
}

inline void ThrowTypeError(Isolate *isolate, const char *message) {
    isolate->ThrowException(Exception::TypeError(NewString(isolate, message)));
}

inline void ThrowError(Isolate *isolate, const char *message) {
    isolate->ThrowException(Exception::Error(NewString(isolate, message)));
}

[[nodiscard]] inline bool
GetProperty(Isolate *isolate, Local<Object> object, const char *name, Local<Value> *result) {
    return object->Get(isolate->GetCurrentContext(), NewString(isolate, name)).ToLocal(result);
}

// CallbackScope supplies Node's top-level callback/uncaught-exception boundary,
// while Function::Call keeps the empty MaybeLocal visible to us. The caller owns
// all native cleanup after false; Node/V8 owns delivery of the original error.
[[nodiscard]] inline bool
CallJs(Isolate *isolate, Local<Function> function, int argc, Local<Value> *argv) {
    Local<Object> receiver = isolate->GetCurrentContext()->Global();
    node::CallbackScope callbackScope(isolate, receiver, {0, 0});
    v8::TryCatch tryCatch(isolate);
    if (!function->Call(isolate->GetCurrentContext(), receiver, argc, argv).IsEmpty()) {
        return true;
    }
    if (tryCatch.HasCaught()) node::FatalException(isolate, tryCatch);
    return false;
}

[[nodiscard]] inline bool CallJsValue(Isolate *isolate,
                                      Local<Function> function,
                                      int argc,
                                      Local<Value> *argv,
                                      Local<Value> *result) {
    Local<Object> receiver = isolate->GetCurrentContext()->Global();
    node::CallbackScope callbackScope(isolate, receiver, {0, 0});
    v8::TryCatch tryCatch(isolate);
    if (function->Call(isolate->GetCurrentContext(), receiver, argc, argv).ToLocal(result)) {
        return true;
    }
    if (tryCatch.HasCaught()) node::FatalException(isolate, tryCatch);
    return false;
}

[[nodiscard]] inline bool CallJsDirect(Isolate *isolate,
                                       Local<Function> function,
                                       int argc,
                                       Local<Value> *argv,
                                       Local<Value> &exception) {
    v8::TryCatch tryCatch(isolate);
    if (!function
             ->Call(
                 isolate->GetCurrentContext(), isolate->GetCurrentContext()->Global(), argc, argv)
             .IsEmpty()) {
        return true;
    }
    if (tryCatch.HasCaught()) exception = tryCatch.Exception();
    return false;
}

inline bool IsHttpTokenCharacter(unsigned char character) {
    if ((character >= '0' && character <= '9') || (character >= 'A' && character <= 'Z') ||
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

inline bool IsValidHeaderName(std::string_view name) {
    return !name.empty() && std::all_of(name.begin(), name.end(), [](unsigned char character) {
        return IsHttpTokenCharacter(character);
    });
}

inline std::string LowercaseHeaderName(std::string_view name) {
    std::string lowercase(name);
    std::transform(
        lowercase.begin(), lowercase.end(), lowercase.begin(), [](unsigned char character) {
            return character >= 'A' && character <= 'Z' ? static_cast<char>(character + ('a' - 'A'))
                                                        : static_cast<char>(character);
        });
    return lowercase;
}

inline bool EqualsAsciiCaseInsensitive(std::string_view left, std::string_view right) {
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

inline bool IsBindingManagedFramingHeader(std::string_view name) {
    return EqualsAsciiCaseInsensitive(name, "content-length") ||
           EqualsAsciiCaseInsensitive(name, "transfer-encoding");
}

inline bool ContainsInvalidHeaderValueCharacter(std::string_view value) {
    return std::any_of(value.begin(), value.end(), [](unsigned char character) {
        return (character < 0x20 && character != '\t') || character == 0x7f;
    });
}

inline bool IsValidStatus(std::string_view status) {
    if (status.length() < 3 || status[0] < '1' || status[0] > '9' || status[1] < '0' ||
        status[1] > '9' || status[2] < '0' || status[2] > '9') {
        return false;
    }

    return (status.length() == 3 || status[3] == ' ') &&
           !ContainsInvalidHeaderValueCharacter(status);
}

inline HttpResponse *GetResponse(const FunctionCallbackInfo<Value> &args) {
    HttpResponse *response = static_cast<HttpResponse *>(GetInternalPointer(args.This()));
    if (!response) {
        ThrowError(args.GetIsolate(), "HTTP response is no longer valid");
    }
    return response;
}

inline void SetPrototypeMethod(Isolate *isolate,
                               Local<FunctionTemplate> target,
                               const char *name,
                               v8::FunctionCallback callback,
                               Local<Value> data = Local<Value>()) {
    target->PrototypeTemplate()->Set(isolate, name, FunctionTemplate::New(isolate, callback, data));
}

void InvalidateResponseObject(Local<Object> object);
void CloseAsyncResponseAfterCallbackFailure(const std::shared_ptr<AsyncResponseState> &state);
Local<ArrayBuffer> CopyToArrayBuffer(Isolate *isolate, std::string_view value);
Local<ArrayBuffer> ExternalArrayBuffer(Isolate *isolate, std::string_view value);

void InitializeResponseBinding(BindingEnvironment *environment, Local<External> contextExternal);
void InitializeRequestBinding(BindingEnvironment *environment, Local<External> contextExternal);
void InitializeWebSocketBinding(BindingEnvironment *environment, Local<External> contextExternal);
void InstallWebSocketAppMethods(Local<FunctionTemplate> app, Local<External> contextExternal);
void InitializeAppBinding(BindingEnvironment *environment,
                          Local<External> contextExternal,
                          Local<Object> exports);

} // namespace swm::binding

#endif // SWM_UWS_BINDING_INTERNAL_H
