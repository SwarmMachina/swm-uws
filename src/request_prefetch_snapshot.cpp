#include "request_prefetch_snapshot.h"

#include <HttpParser.h>

#include <array>
#include <cstring>
#include <limits>
#include <new>

namespace swm {

namespace {

constexpr std::uint16_t kAllHeadersPlanIndex = std::numeric_limits<std::uint16_t>::max();

struct PendingEntry {
    std::uint16_t planIndex;
    std::string_view name;
    std::string_view value;
};

} // namespace

RequestPrefetchSnapshot::RequestPrefetchSnapshot(std::shared_ptr<const RequestPrefetchPlan> plan,
                                                 Layout layout) noexcept
    : plan_(std::move(plan)), allocationBytes_(layout.allocationBytes),
      entryCount_(layout.entryCount) {}

RequestPrefetchSnapshot *
RequestPrefetchSnapshot::Allocate(uWS::HttpRequest &request,
                                  std::shared_ptr<const RequestPrefetchPlan> plan) {
    std::array<PendingEntry, uWS::MAX_HEADER_COUNT_CAPACITY> pending;
    std::size_t entryCount = 0;
    std::size_t payloadBytes = 0;
    for (const auto &[name, value] : request) {
        std::uint16_t planIndex = kAllHeadersPlanIndex;
        if (!plan->SelectsAllHeaders()) {
            const auto selected = plan->Find(name);
            if (!selected) continue;
            planIndex = *selected;
        }
        pending[entryCount++] = {planIndex, name, value};
        if (plan->SelectsAllHeaders()) payloadBytes += name.size();
        payloadBytes += value.size();
    }
    const std::size_t allocationBytes =
        sizeof(RequestPrefetchSnapshot) + entryCount * sizeof(Entry) + payloadBytes;
    auto *snapshot = new (::operator new(allocationBytes))
        RequestPrefetchSnapshot(std::move(plan), {allocationBytes, entryCount});
    std::size_t offset = 0;
    for (std::size_t index = 0; index < entryCount; index++) {
        const auto &entry = pending[index];
        const auto nameOffset = static_cast<std::uint32_t>(offset);
        const auto nameLength = static_cast<std::uint32_t>(
            snapshot->plan_->SelectsAllHeaders() ? entry.name.size() : 0);
        if (nameLength) std::memcpy(snapshot->Bytes() + offset, entry.name.data(), nameLength);
        offset += nameLength;
        const auto valueOffset = static_cast<std::uint32_t>(offset);
        if (!entry.value.empty()) {
            std::memcpy(snapshot->Bytes() + offset, entry.value.data(), entry.value.size());
        }
        offset += entry.value.size();
        snapshot->Entries()[index] = {entry.planIndex,
                                      nameOffset,
                                      nameLength,
                                      valueOffset,
                                      static_cast<std::uint32_t>(entry.value.size())};
    }
    return snapshot;
}

void RequestPrefetchSnapshot::Delete(void *data, std::size_t, void *) noexcept {
    static_cast<RequestPrefetchSnapshot *>(data)->~RequestPrefetchSnapshot();
    ::operator delete(data);
}

std::size_t RequestPrefetchSnapshot::AllocationBytes() const noexcept {
    return allocationBytes_;
}
RequestPrefetchSnapshot::Entry *RequestPrefetchSnapshot::Entries() noexcept {
    return reinterpret_cast<Entry *>(this + 1);
}
const RequestPrefetchSnapshot::Entry *RequestPrefetchSnapshot::Entries() const noexcept {
    return reinterpret_cast<const Entry *>(this + 1);
}
char *RequestPrefetchSnapshot::Bytes() noexcept {
    return reinterpret_cast<char *>(Entries() + entryCount_);
}
const char *RequestPrefetchSnapshot::Bytes() const noexcept {
    return reinterpret_cast<const char *>(Entries() + entryCount_);
}

std::size_t RequestPrefetchSnapshot::EntryCount() const {
    return entryCount_;
}

std::string_view RequestPrefetchSnapshot::EntryName(std::size_t index) const {
    const Entry &entry = Entries()[index];
    if (entry.planIndex != kAllHeadersPlanIndex) {
        return plan_->HeaderNames()[entry.planIndex];
    }
    return std::string_view(Bytes() + entry.nameOffset, entry.nameLength);
}

std::string_view RequestPrefetchSnapshot::EntryValue(std::size_t index) const {
    const Entry &entry = Entries()[index];
    return std::string_view(Bytes() + entry.valueOffset, entry.valueLength);
}

bool RequestPrefetchSnapshot::EntryMatches(std::size_t index,
                                           std::string_view lowercaseName) const {
    return EntryName(index) == lowercaseName;
}

std::optional<std::string_view>
RequestPrefetchSnapshot::FirstValue(std::string_view lowercaseName) const {
    for (std::size_t index = 0; index < entryCount_; index++) {
        if (EntryMatches(index, lowercaseName)) return EntryValue(index);
    }
    return std::nullopt;
}

std::size_t RequestPrefetchSnapshot::ValueCount(std::string_view lowercaseName) const {
    std::size_t count = 0;
    for (std::size_t index = 0; index < entryCount_; index++) {
        if (EntryMatches(index, lowercaseName)) count++;
    }
    return count;
}

} // namespace swm
