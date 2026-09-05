#ifndef SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H
#define SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H

#include "request_prefetch_plan.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string_view>

namespace uWS {
struct HttpRequest;
}

namespace swm {

class RequestPrefetchSnapshot final {
public:
    static RequestPrefetchSnapshot *Allocate(uWS::HttpRequest &request,
                                             std::shared_ptr<const RequestPrefetchPlan> plan);
    static void Delete(void *data, std::size_t length, void *context) noexcept;
    [[nodiscard]] std::size_t AllocationBytes() const noexcept;

    [[nodiscard]] std::size_t EntryCount() const;
    [[nodiscard]] std::string_view EntryName(std::size_t index) const;
    [[nodiscard]] std::string_view EntryValue(std::size_t index) const;
    [[nodiscard]] bool EntryMatches(std::size_t index, std::string_view lowercaseName) const;
    [[nodiscard]] std::optional<std::string_view> FirstValue(std::string_view lowercaseName) const;
    [[nodiscard]] std::size_t ValueCount(std::string_view lowercaseName) const;

private:
    struct Entry {
        std::uint16_t planIndex;
        std::uint32_t nameOffset;
        std::uint32_t nameLength;
        std::uint32_t valueOffset;
        std::uint32_t valueLength;
    };

    struct Layout {
        std::size_t allocationBytes;
        std::size_t entryCount;
    };

    RequestPrefetchSnapshot(std::shared_ptr<const RequestPrefetchPlan> plan,
                            Layout layout) noexcept;
    [[nodiscard]] Entry *Entries() noexcept;
    [[nodiscard]] const Entry *Entries() const noexcept;
    [[nodiscard]] char *Bytes() noexcept;
    [[nodiscard]] const char *Bytes() const noexcept;

    std::shared_ptr<const RequestPrefetchPlan> plan_;
    std::size_t allocationBytes_;
    std::size_t entryCount_;
};

} // namespace swm

#endif // SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H
