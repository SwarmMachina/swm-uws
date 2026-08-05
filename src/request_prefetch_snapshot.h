#ifndef SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H
#define SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H

#include "request_prefetch_plan.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace uWS {
struct HttpRequest;
}

namespace swm {

class RequestPrefetchSnapshot final {
public:
    RequestPrefetchSnapshot(uWS::HttpRequest &request,
                            std::shared_ptr<const RequestPrefetchPlan> plan);

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

    std::shared_ptr<const RequestPrefetchPlan> plan_;
    std::string names_;
    std::string values_;
    std::vector<Entry> entries_;
};

} // namespace swm

#endif // SWM_UWS_REQUEST_PREFETCH_SNAPSHOT_H
