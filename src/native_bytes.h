#ifndef SWM_UWS_NATIVE_BYTES_H
#define SWM_UWS_NATIVE_BYTES_H

#include <v8.h>

#include <algorithm>
#include <array>
#include <limits>
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
            if (string->IsOneByte()) {
                const int characterLength = string->Length();
                char *oneByteData = Allocate(static_cast<std::size_t>(characterLength));
#if V8_MAJOR_VERSION >= 13
                string->WriteOneByteV2(isolate,
                                       0,
                                       static_cast<std::uint32_t>(characterLength),
                                       reinterpret_cast<std::uint8_t *>(oneByteData));
#else
                string->WriteOneByte(isolate,
                                     reinterpret_cast<std::uint8_t *>(oneByteData),
                                     0,
                                     characterLength,
                                     v8::String::NO_NULL_TERMINATION);
#endif
                const bool ascii =
                    std::all_of(oneByteData,
                                oneByteData + characterLength,
                                [](unsigned char character) { return character < 0x80; });
                if (ascii) {
                    data_ = oneByteData;
                    length_ = static_cast<std::size_t>(characterLength);
                    return;
                }
            }
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
            backing_ = view->Buffer()->GetBackingStore();
            length_ = view->ByteLength();
            const std::size_t offset = view->ByteOffset();
            if (!backing_ || offset > backing_->ByteLength() ||
                length_ > backing_->ByteLength() - offset ||
                (!backing_->Data() && (offset != 0 || length_ != 0))) {
                valid_ = false;
                length_ = 0;
                return;
            }
            const auto *base = static_cast<const char *>(backing_->Data());
            data_ = base ? base + offset : "";
            return;
        }

        if (value->IsArrayBuffer()) {
            backing_ = value.As<v8::ArrayBuffer>()->GetBackingStore();
            if (!backing_) {
                valid_ = false;
                return;
            }
            length_ = backing_->ByteLength();
            if (!backing_->Data() && length_ != 0) {
                valid_ = false;
                length_ = 0;
                return;
            }
            data_ = backing_->Data() ? static_cast<const char *>(backing_->Data()) : "";
            return;
        }

        if (value->IsSharedArrayBuffer()) {
            backing_ = value.As<v8::SharedArrayBuffer>()->GetBackingStore();
            if (!backing_) {
                valid_ = false;
                return;
            }
            length_ = backing_->ByteLength();
            if (!backing_->Data() && length_ != 0) {
                valid_ = false;
                length_ = 0;
                return;
            }
            data_ = backing_->Data() ? static_cast<const char *>(backing_->Data()) : "";
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
        return valid_ && length_ <= MaximumLength;
    }

    [[nodiscard]] bool IsTooLarge() const noexcept {
        return valid_ && length_ > MaximumLength;
    }

    [[nodiscard]] std::string_view View() const noexcept {
        return {data_, length_};
    }

    // String bytes in the shared arena remain valid until the outermost
    // NativeBytes instance is destroyed. This lets callers retain a view
    // across inner NativeBytes destructors without copying on the hot path.
    [[nodiscard]] bool IsArenaBacked() const noexcept {
        return arenaBacked_;
    }

private:
    // uSockets accepts signed-int lengths. Reserve enough room for the largest
    // WebSocket frame header so header + payload cannot overflow that contract.
    static constexpr std::size_t MaximumLength =
        static_cast<std::size_t>(std::numeric_limits<int>::max()) - 14;
    static constexpr std::size_t ArenaSize = std::size_t{128} * 1024;
    static constexpr std::size_t ArenaAlignment = 8;
    inline static thread_local std::array<char, ArenaSize> arena_{};
    inline static thread_local std::size_t arenaOffset_ = 0;
    inline static thread_local std::size_t arenaDepth_ = 0;

    char *Allocate(std::size_t length) {
        arenaBacked_ = false;
        const std::size_t remaining = arena_.size() - arenaOffset_;
        if (length <= remaining) {
            const std::size_t alignedLength = (length + ArenaAlignment - 1) & ~(ArenaAlignment - 1);
            if (alignedLength <= remaining) {
                char *data = arena_.data() + arenaOffset_;
                arenaOffset_ += alignedLength;
                arenaBacked_ = true;
                return data;
            }
        }

        fallback_.resize(length);
        return fallback_.data();
    }

    std::string fallback_;
    std::shared_ptr<v8::BackingStore> backing_;
    const char *data_ = "";
    std::size_t length_ = 0;
    bool valid_ = true;
    bool arenaBacked_ = false;
};

} // namespace swm::binding

#endif // SWM_UWS_NATIVE_BYTES_H
