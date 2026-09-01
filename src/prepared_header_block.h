#ifndef SWM_UWS_PREPARED_HEADER_BLOCK_H
#define SWM_UWS_PREPARED_HEADER_BLOCK_H

#include <v8.h>

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <utility>

namespace swm::binding {

class BindingEnvironment;

/**
 * Owns one validated, immutable response-header block for repeated sends.
 *
 * The object, line index, and UTF-8 payload live in one ArrayBuffer backing
 * store. Its byte length therefore gives V8 exact native-memory accounting,
 * and its deleter never needs to enter an isolate.
 */
class PreparedHeaderBlock final {
public:
    static constexpr std::size_t MaximumHeaderPairs = 64;
    static constexpr std::size_t MaximumPayloadBytes = std::size_t{64} * 1024;

    PreparedHeaderBlock(const PreparedHeaderBlock &) = delete;
    PreparedHeaderBlock &operator=(const PreparedHeaderBlock &) = delete;

    static void Initialize(BindingEnvironment *environment, v8::Local<v8::Object> exports);
    [[nodiscard]] static PreparedHeaderBlock *From(v8::Local<v8::Value> value,
                                                   const void *environmentToken);

    [[nodiscard]] std::size_t HeaderCount() const noexcept;
    [[nodiscard]] std::pair<std::string_view, std::string_view>
    Header(std::size_t index) const noexcept;

private:
    struct Layout final {
        std::size_t allocationBytes;
        std::uint32_t headerCount;
        std::uint32_t payloadBytes;
    };

    PreparedHeaderBlock(const void *environmentToken, Layout layout) noexcept;
    ~PreparedHeaderBlock() = default;

    static void Construct(const v8::FunctionCallbackInfo<v8::Value> &args);
    [[nodiscard]] static PreparedHeaderBlock *
    Allocate(const void *environmentToken, std::size_t headerCount, std::size_t payloadBytes);
    static void DeleteBackingStore(void *data, std::size_t length, void *deleterData) noexcept;

    [[nodiscard]] std::uint32_t *MutableLines() noexcept;
    [[nodiscard]] const std::uint32_t *Lines() const noexcept;
    [[nodiscard]] char *MutableBytes() noexcept;
    [[nodiscard]] const char *Bytes() const noexcept;

    const void *environmentToken_;
    std::size_t allocationBytes_;
    std::uint32_t headerCount_;
    std::uint32_t payloadBytes_;
};

} // namespace swm::binding

#endif // SWM_UWS_PREPARED_HEADER_BLOCK_H
