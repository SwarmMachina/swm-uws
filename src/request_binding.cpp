#include "binding_internal.h"

namespace swm::binding {

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
        ThrowTypeError(args.GetIsolate(), "req.getCaseSensitiveMethod() does not accept arguments");
        return;
    }
    args.GetReturnValue().Set(NewString(args.GetIsolate(), request->getCaseSensitiveMethod()));
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
        ThrowTypeError(args.GetIsolate(), "req.getHeader(name) expects a valid HTTP header name");
        return;
    }
    std::string name(nativeName.View());
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
        return character >= 'A' && character <= 'Z' ? static_cast<char>(character + ('a' - 'A'))
                                                    : static_cast<char>(character);
    });
    args.GetReturnValue().Set(NewOneByteString(args.GetIsolate(), request->getHeader(name)));
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
        ThrowTypeError(args.GetIsolate(),
                       "req.getParameter(indexOrName) expects a number or string");
        return;
    }
    if (!args[0]->IsNumber()) {
        NativeBytes name(args.GetIsolate(), args[0]);
        if (!name.IsValid()) {
            ThrowTypeError(args.GetIsolate(),
                           "req.getParameter(indexOrName) expects a number, string, or buffer");
            return;
        }
        std::string_view value = request->getParameter(name.View());
        if (value.data()) args.GetReturnValue().Set(NewString(args.GetIsolate(), value));
        return;
    }
    const double indexNumber =
        args[0]->NumberValue(args.GetIsolate()->GetCurrentContext()).FromMaybe(-1);
    if (!std::isfinite(indexNumber) || indexNumber < 0 || indexNumber > 65535 ||
        std::floor(indexNumber) != indexNumber) {
        ThrowTypeError(args.GetIsolate(), "req.getParameter(index) expects a valid index");
        return;
    }
    std::string_view value = request->getParameter(static_cast<unsigned short>(indexNumber));
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
        if (!CallJsDirect(isolate, handler, 2, argv, exception)) {
            if (!exception.IsEmpty()) isolate->ThrowException(exception);
            return;
        }
    }
}

using RequestPrefetchPlanPointer = std::shared_ptr<const swm::RequestPrefetchPlan>;

RequestPrefetchPlanPointer *GetRequestPrefetchPlanHolder(Isolate *isolate, Local<Object> object) {
    if (object->InternalFieldCount() != 1) {
        ThrowTypeError(isolate, "invalid RequestPrefetchPlan receiver");
        return nullptr;
    }
    Local<Value> storage = object->GetInternalField(0).As<Value>();
    if (!storage->IsArrayBuffer()) {
        ThrowTypeError(isolate, "invalid RequestPrefetchPlan receiver");
        return nullptr;
    }
    return static_cast<RequestPrefetchPlanPointer *>(
        storage.As<ArrayBuffer>()->GetBackingStore()->Data());
}

swm::RequestPrefetchSnapshot *GetRequestPrefetchSnapshot(Isolate *isolate, Local<Object> object) {
    if (object->InternalFieldCount() != 3) {
        ThrowTypeError(isolate, "invalid RequestPrefetchSnapshot receiver");
        return nullptr;
    }
    Local<Value> storage = object->GetInternalField(0).As<Value>();
    if (!storage->IsArrayBuffer()) {
        ThrowTypeError(isolate, "invalid RequestPrefetchSnapshot receiver");
        return nullptr;
    }
    return static_cast<swm::RequestPrefetchSnapshot *>(
        storage.As<ArrayBuffer>()->GetBackingStore()->Data());
}

bool ReadPrefetchHeaderName(const FunctionCallbackInfo<Value> &args,
                            std::string *lowercaseName,
                            const char *signature) {
    if (args.Length() != 1 || !args[0]->IsString()) {
        ThrowTypeError(args.GetIsolate(), signature);
        return false;
    }
    NativeBytes name(args.GetIsolate(), args[0]);
    if (!name.IsValid() || !IsValidHeaderName(name.View())) {
        ThrowTypeError(args.GetIsolate(), signature);
        return false;
    }
    *lowercaseName = LowercaseHeaderName(name.View());
    return true;
}

void RequestPrefetchPlanConstructor(const FunctionCallbackInfo<Value> &args) {
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    if (!args.IsConstructCall() || args.Length() != 1 || !args[0]->IsObject() ||
        args[0]->IsArray() || args[0]->IsFunction()) {
        ThrowTypeError(isolate, "new RequestPrefetchPlan(options) expects an options object");
        return;
    }

    Local<Object> options = args[0].As<Object>();
    Local<Array> optionNames;
    if (!options->GetOwnPropertyNames(context).ToLocal(&optionNames)) return;
    for (std::uint32_t index = 0; index < optionNames->Length(); index++) {
        Local<Value> key;
        if (!optionNames->Get(context, index).ToLocal(&key)) return;
        if (!key->IsString() || !key->StrictEquals(NewString(isolate, "headers"))) {
            ThrowTypeError(isolate, "unknown RequestPrefetchPlan option");
            return;
        }
    }

    Local<Value> headers;
    if (!options->Get(context, NewString(isolate, "headers")).ToLocal(&headers)) return;
    bool allHeaders = false;
    std::vector<std::string> headerNames;
    if (headers->IsString()) {
        NativeBytes selection(isolate, headers);
        if (!selection.IsValid() || selection.View() != "all") {
            ThrowTypeError(isolate,
                           "RequestPrefetchPlan headers must be 'all' or an array of header names");
            return;
        }
        allHeaders = true;
    } else if (headers->IsArray()) {
        Local<Array> selected = headers.As<Array>();
        if (selected->Length() > std::numeric_limits<std::uint16_t>::max()) {
            ThrowTypeError(isolate, "RequestPrefetchPlan contains too many header names");
            return;
        }
        headerNames.reserve(selected->Length());
        std::unordered_set<std::string> seen;
        seen.reserve(selected->Length());
        for (std::uint32_t index = 0; index < selected->Length(); index++) {
            Local<Value> value;
            if (!selected->Get(context, index).ToLocal(&value)) return;
            if (!value->IsString()) {
                ThrowTypeError(isolate, "RequestPrefetchPlan header names must be strings");
                return;
            }
            NativeBytes nativeName(isolate, value);
            if (!nativeName.IsValid() || !IsValidHeaderName(nativeName.View()) ||
                nativeName.View().size() > std::numeric_limits<std::uint16_t>::max()) {
                ThrowTypeError(isolate, "RequestPrefetchPlan contains an invalid HTTP header name");
                return;
            }
            std::string name = LowercaseHeaderName(nativeName.View());
            if (seen.insert(name).second) headerNames.push_back(std::move(name));
        }
    } else {
        ThrowTypeError(isolate,
                       "RequestPrefetchPlan headers must be 'all' or an array of header names");
        return;
    }

    auto *contextData = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    auto *holder = new RequestPrefetchPlanPointer(std::make_shared<const swm::RequestPrefetchPlan>(
        contextData, allHeaders, std::move(headerNames)));
    std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
        holder,
        sizeof(*holder),
        [](void *data, size_t, void *) { delete static_cast<RequestPrefetchPlanPointer *>(data); },
        nullptr);
    args.This()->SetInternalField(0, ArrayBuffer::New(isolate, std::move(backing)));

    Local<Array> publicNames =
        Array::New(isolate, static_cast<int>((*holder)->HeaderNames().size()));
    for (std::size_t index = 0; index < (*holder)->HeaderNames().size(); index++) {
        if (!publicNames
                 ->Set(context,
                       static_cast<std::uint32_t>(index),
                       NewOneByteString(isolate, (*holder)->HeaderNames()[index]))
                 .FromMaybe(false)) {
            return;
        }
    }
    if (!publicNames->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen).FromMaybe(false)) {
        return;
    }
    v8::PropertyDescriptor descriptor(publicNames, false);
    descriptor.set_enumerable(true);
    descriptor.set_configurable(false);
    if (!args.This()
             ->DefineProperty(context, NewString(isolate, "headerNames"), descriptor)
             .FromMaybe(false)) {
        return;
    }
    args.This()->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen).ToChecked();
    args.GetReturnValue().Set(args.This());
}

void PrefetchSnapshotGetHeader(const FunctionCallbackInfo<Value> &args) {
    swm::RequestPrefetchSnapshot *snapshot =
        GetRequestPrefetchSnapshot(args.GetIsolate(), args.This());
    if (!snapshot) return;
    std::string name;
    if (!ReadPrefetchHeaderName(
            args, &name, "snapshot.getHeader(name) expects a valid HTTP header name")) {
        return;
    }
    const std::optional<std::string_view> value = snapshot->FirstValue(name);
    if (value) args.GetReturnValue().Set(NewOneByteString(args.GetIsolate(), *value));
}

void PrefetchSnapshotGetHeaderValues(const FunctionCallbackInfo<Value> &args) {
    swm::RequestPrefetchSnapshot *snapshot =
        GetRequestPrefetchSnapshot(args.GetIsolate(), args.This());
    if (!snapshot) return;
    std::string name;
    if (!ReadPrefetchHeaderName(
            args, &name, "snapshot.getHeaderValues(name) expects a valid HTTP header name")) {
        return;
    }
    const std::size_t valueCount = snapshot->ValueCount(name);
    if (!valueCount) return;
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Array> values = Array::New(isolate, static_cast<int>(valueCount));
    std::uint32_t outputIndex = 0;
    for (std::size_t index = 0; index < snapshot->EntryCount(); index++) {
        if (!snapshot->EntryMatches(index, name)) continue;
        if (!values
                 ->Set(
                     context, outputIndex++, NewOneByteString(isolate, snapshot->EntryValue(index)))
                 .FromMaybe(false)) {
            return;
        }
    }
    values->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen).ToChecked();
    args.GetReturnValue().Set(values);
}

void PrefetchSnapshotGetHeaders(const FunctionCallbackInfo<Value> &args) {
    swm::RequestPrefetchSnapshot *snapshot =
        GetRequestPrefetchSnapshot(args.GetIsolate(), args.This());
    if (!snapshot) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "snapshot.getHeaders() does not accept arguments");
        return;
    }
    Local<Value> cached = args.This()->GetInternalField(1).As<Value>();
    if (!cached->IsUndefined()) {
        args.GetReturnValue().Set(cached);
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    auto *contextData = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    Local<Object> headers = contextData->CloneRequestPrefetchHeadersTemplate();
    for (std::size_t index = 0; index < snapshot->EntryCount(); index++) {
        if (!headers
                 ->CreateDataProperty(context,
                                      NewOneByteString(isolate, snapshot->EntryName(index)),
                                      NewOneByteString(isolate, snapshot->EntryValue(index)))
                 .FromMaybe(false)) {
            return;
        }
    }
    args.This()->SetInternalField(1, headers);
    args.GetReturnValue().Set(headers);
}

void PrefetchSnapshotGetHeaderEntries(const FunctionCallbackInfo<Value> &args) {
    swm::RequestPrefetchSnapshot *snapshot =
        GetRequestPrefetchSnapshot(args.GetIsolate(), args.This());
    if (!snapshot) return;
    if (args.Length() != 0) {
        ThrowTypeError(args.GetIsolate(), "snapshot.getHeaderEntries() does not accept arguments");
        return;
    }
    Local<Value> cached = args.This()->GetInternalField(2).As<Value>();
    if (!cached->IsUndefined()) {
        args.GetReturnValue().Set(cached);
        return;
    }
    Isolate *isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();
    Local<Array> entries = Array::New(isolate, static_cast<int>(snapshot->EntryCount() * 2));
    for (std::size_t index = 0; index < snapshot->EntryCount(); index++) {
        if (!entries
                 ->Set(context,
                       static_cast<std::uint32_t>(index * 2),
                       NewOneByteString(isolate, snapshot->EntryName(index)))
                 .FromMaybe(false) ||
            !entries
                 ->Set(context,
                       static_cast<std::uint32_t>(index * 2 + 1),
                       NewOneByteString(isolate, snapshot->EntryValue(index)))
                 .FromMaybe(false)) {
            return;
        }
    }
    entries->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen).ToChecked();
    args.This()->SetInternalField(2, entries);
    args.GetReturnValue().Set(entries);
}

void RequestPrefetch(const FunctionCallbackInfo<Value> &args) {
    uWS::HttpRequest *request = GetRequest(args);
    if (!request) return;
    if (args.Length() != 1 || !args[0]->IsObject()) {
        ThrowTypeError(args.GetIsolate(), "req.prefetch(plan) expects a RequestPrefetchPlan");
        return;
    }
    Isolate *isolate = args.GetIsolate();
    auto *contextData = static_cast<BindingEnvironment *>(args.Data().As<External>()->Value());
    RequestPrefetchPlanPointer *holder =
        GetRequestPrefetchPlanHolder(isolate, args[0].As<Object>());
    if (!holder) return;
    if (!*holder || (*holder)->EnvironmentToken() != contextData) {
        ThrowTypeError(isolate, "RequestPrefetchPlan belongs to a different N-API environment");
        return;
    }

    auto *snapshot = new swm::RequestPrefetchSnapshot(*request, *holder);
    std::unique_ptr<v8::BackingStore> backing = ArrayBuffer::NewBackingStore(
        snapshot,
        sizeof(*snapshot),
        [](void *data, size_t, void *) {
            delete static_cast<swm::RequestPrefetchSnapshot *>(data);
        },
        nullptr);
    Local<ArrayBuffer> storage = ArrayBuffer::New(isolate, std::move(backing));
    Local<Object> object = contextData->CloneRequestPrefetchSnapshotTemplate();
    object->SetInternalField(0, storage);
    object->SetInternalField(1, v8::Undefined(isolate));
    object->SetInternalField(2, v8::Undefined(isolate));
    args.GetReturnValue().Set(object);
}

void InitializeRequestBinding(BindingEnvironment *context, Local<External> contextExternal) {
    Isolate *isolate = context->Isolate();
    Local<FunctionTemplate> request = FunctionTemplate::New(isolate);
    request->InstanceTemplate()->SetInternalFieldCount(1);
    SetPrototypeMethod(isolate, request, "getMethod", RequestGetMethod);
    SetPrototypeMethod(isolate, request, "getCaseSensitiveMethod", RequestGetCaseSensitiveMethod);
    SetPrototypeMethod(isolate, request, "getUrl", RequestGetUrl);
    SetPrototypeMethod(isolate, request, "getHeader", RequestGetHeader);
    SetPrototypeMethod(isolate, request, "getQuery", RequestGetQuery);
    SetPrototypeMethod(isolate, request, "getParameter", RequestGetParameter);
    SetPrototypeMethod(isolate, request, "setYield", RequestSetYield);
    SetPrototypeMethod(isolate, request, "forEach", RequestForEach);
    SetPrototypeMethod(isolate, request, "prefetch", RequestPrefetch, contextExternal);
    context->SetRequestTemplate(request->GetFunction(isolate->GetCurrentContext())
                                    .ToLocalChecked()
                                    ->NewInstance(isolate->GetCurrentContext())
                                    .ToLocalChecked());

    Local<FunctionTemplate> prefetchSnapshot = FunctionTemplate::New(isolate);
    prefetchSnapshot->InstanceTemplate()->SetInternalFieldCount(3);
    SetPrototypeMethod(isolate, prefetchSnapshot, "getHeader", PrefetchSnapshotGetHeader);
    SetPrototypeMethod(
        isolate, prefetchSnapshot, "getHeaderValues", PrefetchSnapshotGetHeaderValues);
    SetPrototypeMethod(
        isolate, prefetchSnapshot, "getHeaders", PrefetchSnapshotGetHeaders, contextExternal);
    SetPrototypeMethod(
        isolate, prefetchSnapshot, "getHeaderEntries", PrefetchSnapshotGetHeaderEntries);
    Local<Object> prefetchSnapshotTemplate =
        prefetchSnapshot->GetFunction(isolate->GetCurrentContext())
            .ToLocalChecked()
            ->NewInstance(isolate->GetCurrentContext())
            .ToLocalChecked();
    context->SetRequestPrefetchSnapshotTemplate(prefetchSnapshotTemplate);
    context->SetRequestPrefetchHeadersTemplate(
        Object::New(isolate, Null(isolate), nullptr, nullptr, 0));

    Local<FunctionTemplate> prefetchPlan =
        FunctionTemplate::New(isolate, RequestPrefetchPlanConstructor, contextExternal);
    prefetchPlan->SetClassName(NewString(isolate, "RequestPrefetchPlan"));
    prefetchPlan->InstanceTemplate()->SetInternalFieldCount(1);
    context->SetRequestPrefetchPlanConstructor(
        prefetchPlan->GetFunction(isolate->GetCurrentContext()).ToLocalChecked());
}

} // namespace swm::binding
