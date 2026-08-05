#include "request_prefetch_snapshot.h"

#include <HttpParser.h>

#include <array>
#include <limits>

namespace swm {

namespace {

constexpr std::size_t kHeaderCapacity = 100;
constexpr std::uint16_t kAllHeadersPlanIndex = std::numeric_limits<std::uint16_t>::max();

struct PendingEntry {
    std::uint16_t planIndex;
    std::string_view name;
    std::string_view value;
};

} // namespace

RequestPrefetchSnapshot::RequestPrefetchSnapshot(uWS::HttpRequest &request,
                                                 std::shared_ptr<const RequestPrefetchPlan> plan)
    : plan_(std::move(plan)) {
    std::array<PendingEntry, kHeaderCapacity> pending;
    std::size_t entryCount = 0;
    std::size_t nameBytes = 0;
    std::size_t valueBytes = 0;

    for (const auto &[name, value] : request) {
        std::uint16_t planIndex = kAllHeadersPlanIndex;
        if (!plan_->SelectsAllHeaders()) {
            const std::optional<std::uint16_t> selected = plan_->Find(name);
            if (!selected) continue;
            planIndex = *selected;
        }

        pending[entryCount++] = {planIndex, name, value};
        if (plan_->SelectsAllHeaders()) nameBytes += name.size();
        valueBytes += value.size();
    }

    names_.reserve(nameBytes);
    values_.reserve(valueBytes);
    entries_.reserve(entryCount);
    for (std::size_t index = 0; index < entryCount; index++) {
        const PendingEntry &entry = pending[index];
        const std::uint32_t nameOffset = static_cast<std::uint32_t>(names_.size());
        const std::uint32_t valueOffset = static_cast<std::uint32_t>(values_.size());
        if (plan_->SelectsAllHeaders()) names_.append(entry.name);
        values_.append(entry.value);
        entries_.push_back({
            entry.planIndex,
            nameOffset,
            static_cast<std::uint32_t>(plan_->SelectsAllHeaders() ? entry.name.size() : 0),
            valueOffset,
            static_cast<std::uint32_t>(entry.value.size()),
        });
    }
}

std::size_t RequestPrefetchSnapshot::EntryCount() const {
    return entries_.size();
}

std::string_view RequestPrefetchSnapshot::EntryName(std::size_t index) const {
    const Entry &entry = entries_[index];
    if (entry.planIndex != kAllHeadersPlanIndex) {
        return plan_->HeaderNames()[entry.planIndex];
    }
    return std::string_view(names_).substr(entry.nameOffset, entry.nameLength);
}

std::string_view RequestPrefetchSnapshot::EntryValue(std::size_t index) const {
    const Entry &entry = entries_[index];
    return std::string_view(values_).substr(entry.valueOffset, entry.valueLength);
}

bool RequestPrefetchSnapshot::EntryMatches(std::size_t index,
                                           std::string_view lowercaseName) const {
    return EntryName(index) == lowercaseName;
}

std::optional<std::string_view>
RequestPrefetchSnapshot::FirstValue(std::string_view lowercaseName) const {
    for (std::size_t index = 0; index < entries_.size(); index++) {
        if (EntryMatches(index, lowercaseName)) return EntryValue(index);
    }
    return std::nullopt;
}

std::size_t RequestPrefetchSnapshot::ValueCount(std::string_view lowercaseName) const {
    std::size_t count = 0;
    for (std::size_t index = 0; index < entries_.size(); index++) {
        if (EntryMatches(index, lowercaseName)) count++;
    }
    return count;
}

} // namespace swm
