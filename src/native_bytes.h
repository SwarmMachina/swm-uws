#ifndef SWM_UWS_NATIVE_BYTES_H
#define SWM_UWS_NATIVE_BYTES_H

#include <v8.h>

#include <array>
#include <memory>
#include <string>
#include <string_view>

namespace swm::binding {

// Arena-backed views remain valid while all enclosing NativeBytes instances
// are alive: only the outermost construction resets the thread-local arena and
// nested instances reserve later bytes. Fallback storage belongs to this
// instance. A View() must never outlive its owner. Callers must not enter
// re-entrant JavaScript between acquiring an otherwise unstable view and its
// final native use; copy first when that rule cannot be satisfied.
class NativeBytes final {
public:
    explicit NativeBytes(v8::Isolate *isolate,
                         v8::Local<v8::Value> value,
                         bool allowUndefined = false) {
        if (arenaDepth_++ == 0) arenaOffset_ = 0;

        if (allowUndefined && value->IsUndefined()) return;

        if (value->IsString()) {
            v8::Local<v8::String> string = value.As<v8::String>();
#if V8_MAJOR_VERSION >= 13
            const size_t length = string->Utf8LengthV2(isolate);
            char *data = Allocate(length);
            string->WriteUtf8V2(isolate, data, length);
#else
            const int length = string->Utf8Length(isolate);
            char *data = Allocate(static_cast<std::size_t>(length));
            string->WriteUtf8(isolate, data, length, nullptr, v8::String::NO_NULL_TERMINATION);
#endif
            data_ = data;
            length_ = static_cast<std::size_t>(length);
            return;
        }

        if (value->IsArrayBufferView()) {
            v8::Local<v8::ArrayBufferView> view = value.As<v8::ArrayBufferView>();
            std::shared_ptr<v8::BackingStore> backing = view->Buffer()->GetBackingStore();
            data_ = static_cast<const char *>(backing->Data()) + view->ByteOffset();
            length_ = view->ByteLength();
            return;
        }

        if (value->IsArrayBuffer()) {
            std::shared_ptr<v8::BackingStore> backing =
                value.As<v8::ArrayBuffer>()->GetBackingStore();
            data_ = static_cast<const char *>(backing->Data());
            length_ = backing->ByteLength();
            return;
        }

        if (value->IsSharedArrayBuffer()) {
            std::shared_ptr<v8::BackingStore> backing =
                value.As<v8::SharedArrayBuffer>()->GetBackingStore();
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

    [[nodiscard]] bool IsValid() const noexcept {
        return valid_;
    }

    [[nodiscard]] std::string_view View() const noexcept {
        return {data_, length_};
    }

private:
    static constexpr std::size_t ArenaSize = std::size_t{128} * 1024;
    static constexpr std::size_t ArenaAlignment = 8;
    inline static thread_local std::array<char, ArenaSize> arena_{};
    inline static thread_local std::size_t arenaOffset_ = 0;
    inline static thread_local std::size_t arenaDepth_ = 0;

    char *Allocate(std::size_t length) {
        const std::size_t remaining = arena_.size() - arenaOffset_;
        if (length <= remaining) {
            const std::size_t alignedLength = (length + ArenaAlignment - 1) & ~(ArenaAlignment - 1);
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

} // namespace swm::binding

#endif // SWM_UWS_NATIVE_BYTES_H
