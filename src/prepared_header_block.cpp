#include "prepared_header_block.h"

#include "binding_environment.h"
#include "binding_internal.h"

#include <algorithm>
#include <new>
#include <string>
#include <vector>

namespace swm::binding {

namespace {

constexpr std::size_t kLineFields = 4;

bool MeasureUtf8(v8::Isolate *isolate,
                 v8::Local<v8::String> value,
                 std::size_t remaining,
                 std::size_t *result) {
    std::size_t bytes;
    if (!MeasureUtf8Length(isolate, value, &bytes)) return false;
    if (bytes > remaining) return false;
    *result = bytes;
    return true;
}

} // namespace

PreparedHeaderBlock::PreparedHeaderBlock(const void *environmentToken, Layout layout) noexcept
    : environmentToken_(environmentToken), allocationBytes_(layout.allocationBytes),
      headerCount_(layout.headerCount), payloadBytes_(layout.payloadBytes) {}

PreparedHeaderBlock *PreparedHeaderBlock::Allocate(const void *environmentToken,
                                                   std::size_t headerCount,
                                                   std::size_t payloadBytes) {
    const std::size_t lineBytes = headerCount * kLineFields * sizeof(std::uint32_t);
    const std::size_t allocationBytes = sizeof(PreparedHeaderBlock) + lineBytes + payloadBytes;
    void *storage = ::operator new(allocationBytes);
    return new (storage)
        PreparedHeaderBlock(environmentToken,
                            Layout{
                                .allocationBytes = allocationBytes,
                                .headerCount = static_cast<std::uint32_t>(headerCount),
                                .payloadBytes = static_cast<std::uint32_t>(payloadBytes),
                            });
}

void PreparedHeaderBlock::DeleteBackingStore(void *data, std::size_t, void *) noexcept {
    auto *block = static_cast<PreparedHeaderBlock *>(data);
    block->~PreparedHeaderBlock();
    ::operator delete(data);
}

std::uint32_t *PreparedHeaderBlock::MutableLines() noexcept {
    return reinterpret_cast<std::uint32_t *>(this + 1);
}

const std::uint32_t *PreparedHeaderBlock::Lines() const noexcept {
    return reinterpret_cast<const std::uint32_t *>(this + 1);
}

char *PreparedHeaderBlock::MutableBytes() noexcept {
    return reinterpret_cast<char *>(MutableLines() + headerCount_ * kLineFields);
}

const char *PreparedHeaderBlock::Bytes() const noexcept {
    return reinterpret_cast<const char *>(Lines() + headerCount_ * kLineFields);
}

void PreparedHeaderBlock::Initialize(BindingEnvironment *environment,
                                     v8::Local<v8::Object> exports) {
    v8::Isolate *isolate = environment->Isolate();
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    v8::Local<v8::FunctionTemplate> constructor =
        v8::FunctionTemplate::New(isolate, Construct, v8::External::New(isolate, environment));
    constructor->SetClassName(NewString(isolate, "PreparedHeaderBlock"));
    constructor->InstanceTemplate()->SetInternalFieldCount(2);
    exports
        ->Set(context,
              NewString(isolate, "PreparedHeaderBlock"),
              constructor->GetFunction(context).ToLocalChecked())
        .ToChecked();
}

void PreparedHeaderBlock::Construct(const v8::FunctionCallbackInfo<v8::Value> &args) {
    v8::Isolate *isolate = args.GetIsolate();
    if (!args.IsConstructCall() || args.Length() != 1 || !args[0]->IsArray()) {
        ThrowTypeError(isolate, "new PreparedHeaderBlock(headerLines) expects a flat string array");
        return;
    }

    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    v8::Local<v8::Array> input = args[0].As<v8::Array>();
    const std::uint32_t length = input->Length();
    if ((length & 1U) != 0) {
        ThrowTypeError(isolate, "PreparedHeaderBlock headerLines must contain name/value pairs");
        return;
    }
    if (length / 2U > MaximumHeaderPairs) {
        ThrowRangeError(isolate, "PreparedHeaderBlock accepts at most 64 header pairs");
        return;
    }

    std::vector<std::pair<std::string, std::string>> inputLines;
    inputLines.reserve(length / 2U);
    std::size_t payloadBytes = 0;
    for (std::uint32_t index = 0; index < length; index += 2) {
        v8::Local<v8::Value> nameValue;
        v8::Local<v8::Value> headerValue;
        if (!input->Get(context, index).ToLocal(&nameValue) ||
            !input->Get(context, index + 1).ToLocal(&headerValue)) {
            return;
        }
        if (!nameValue->IsString() || !headerValue->IsString()) {
            ThrowTypeError(isolate, "PreparedHeaderBlock entries must be strings");
            return;
        }

        std::size_t nameBytes;
        std::size_t valueBytes;
        if (!MeasureUtf8(isolate,
                         nameValue.As<v8::String>(),
                         MaximumPayloadBytes - payloadBytes,
                         &nameBytes)) {
            ThrowRangeError(isolate, "PreparedHeaderBlock exceeds 64 KiB");
            return;
        }
        payloadBytes += nameBytes;
        if (!MeasureUtf8(isolate,
                         headerValue.As<v8::String>(),
                         MaximumPayloadBytes - payloadBytes,
                         &valueBytes)) {
            ThrowRangeError(isolate, "PreparedHeaderBlock exceeds 64 KiB");
            return;
        }
        payloadBytes += valueBytes;

        NativeBytes name(isolate, nameValue);
        NativeBytes value(isolate, headerValue);
        if (!name.IsValid() || !value.IsValid() || !IsValidHeaderName(name.View()) ||
            ContainsInvalidHeaderValueCharacter(value.View())) {
            ThrowTypeError(isolate, "PreparedHeaderBlock received an invalid header");
            return;
        }
        if (IsBindingManagedFramingHeader(name.View())) {
            ThrowTypeError(
                isolate, "PreparedHeaderBlock cannot contain Content-Length or Transfer-Encoding");
            return;
        }
        inputLines.emplace_back(name.View(), value.View());
    }

    auto *environment = static_cast<BindingEnvironment *>(args.Data().As<v8::External>()->Value());
    auto *block = Allocate(environment, inputLines.size(), payloadBytes);
    std::uint32_t *lines = block->MutableLines();
    char *bytes = block->MutableBytes();
    std::size_t line = 0;
    std::size_t byteOffset = 0;
    for (const auto &[name, value] : inputLines) {
        lines[line++] = static_cast<std::uint32_t>(byteOffset);
        lines[line++] = static_cast<std::uint32_t>(name.size());
        std::copy(name.begin(), name.end(), bytes + byteOffset);
        byteOffset += name.size();
        lines[line++] = static_cast<std::uint32_t>(byteOffset);
        lines[line++] = static_cast<std::uint32_t>(value.size());
        std::copy(value.begin(), value.end(), bytes + byteOffset);
        byteOffset += value.size();
    }

    std::unique_ptr<v8::BackingStore> backing = v8::ArrayBuffer::NewBackingStore(
        block, block->allocationBytes_, DeleteBackingStore, nullptr);
    args.This()->SetInternalField(0, v8::ArrayBuffer::New(isolate, std::move(backing)));
    SetBindingObjectKind(args.This(), BindingObjectKind::PreparedHeaderBlock, 1);
    if (!args.This()->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen).FromMaybe(false)) {
        return;
    }
    args.GetReturnValue().Set(args.This());
}

PreparedHeaderBlock *PreparedHeaderBlock::From(v8::Local<v8::Value> value,
                                               const void *environmentToken) {
    if (!value->IsObject()) return nullptr;
    v8::Local<v8::Object> object = value.As<v8::Object>();
    if (object->InternalFieldCount() != 2 ||
        !HasBindingObjectKind(object, BindingObjectKind::PreparedHeaderBlock, 1)) {
        return nullptr;
    }
    v8::Local<v8::Value> storage = object->GetInternalField(0).As<v8::Value>();
    if (!storage->IsArrayBuffer()) return nullptr;
    std::shared_ptr<v8::BackingStore> backing = storage.As<v8::ArrayBuffer>()->GetBackingStore();
    if (backing->ByteLength() < sizeof(PreparedHeaderBlock)) return nullptr;
    auto *block = static_cast<PreparedHeaderBlock *>(backing->Data());
    return block && block->allocationBytes_ == backing->ByteLength() &&
                   block->environmentToken_ == environmentToken
               ? block
               : nullptr;
}

std::size_t PreparedHeaderBlock::HeaderCount() const noexcept {
    return headerCount_;
}

std::pair<std::string_view, std::string_view>
PreparedHeaderBlock::Header(std::size_t index) const noexcept {
    const std::size_t line = index * kLineFields;
    const std::uint32_t *lines = Lines();
    const std::string_view bytes(Bytes(), payloadBytes_);
    return {
        bytes.substr(lines[line], lines[line + 1]),
        bytes.substr(lines[line + 2], lines[line + 3]),
    };
}

} // namespace swm::binding
