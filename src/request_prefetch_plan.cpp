#include "request_prefetch_plan.h"

#include <algorithm>
#include <limits>

namespace swm {

namespace {

constexpr std::size_t kLinearLookupLimit = 8;

std::size_t NextPowerOfTwo(std::size_t value) {
    std::size_t result = 1;
    while (result < value) result <<= 1;
    return result;
}

} // namespace

RequestPrefetchPlan::RequestPrefetchPlan(const void *environmentToken,
                                         bool allHeaders,
                                         std::vector<std::string> headerNames)
    : environmentToken_(environmentToken), allHeaders_(allHeaders),
      headerNames_(std::move(headerNames)) {
    compiledNames_.reserve(headerNames_.size());
    for (const std::string &name : headerNames_) {
        compiledNames_.push_back({
            Hash(name),
            static_cast<std::uint16_t>(name.size()),
        });
    }

    if (headerNames_.size() <= kLinearLookupLimit) return;

    const std::size_t tableSize = NextPowerOfTwo(headerNames_.size() * 2);
    lookupTable_.assign(tableSize, -1);
    for (std::size_t index = 0; index < headerNames_.size(); index++) {
        std::size_t slot = compiledNames_[index].hash & (tableSize - 1);
        while (lookupTable_[slot] != -1) slot = (slot + 1) & (tableSize - 1);
        lookupTable_[slot] = static_cast<std::int32_t>(index);
    }
}

const void *RequestPrefetchPlan::EnvironmentToken() const {
    return environmentToken_;
}

bool RequestPrefetchPlan::SelectsAllHeaders() const {
    return allHeaders_;
}

const std::vector<std::string> &RequestPrefetchPlan::HeaderNames() const {
    return headerNames_;
}

std::optional<std::uint16_t> RequestPrefetchPlan::Find(std::string_view lowercaseName) const {
    if (allHeaders_) return std::nullopt;
    const std::uint32_t hash = Hash(lowercaseName);

    if (lookupTable_.empty()) {
        for (std::size_t index = 0; index < headerNames_.size(); index++) {
            const CompiledName &compiled = compiledNames_[index];
            if (compiled.hash == hash && compiled.length == lowercaseName.size() &&
                headerNames_[index] == lowercaseName) {
                return static_cast<std::uint16_t>(index);
            }
        }
        return std::nullopt;
    }

    std::size_t slot = hash & (lookupTable_.size() - 1);
    while (lookupTable_[slot] != -1) {
        const std::size_t index = static_cast<std::size_t>(lookupTable_[slot]);
        const CompiledName &compiled = compiledNames_[index];
        if (compiled.hash == hash && compiled.length == lowercaseName.size() &&
            headerNames_[index] == lowercaseName) {
            return static_cast<std::uint16_t>(index);
        }
        slot = (slot + 1) & (lookupTable_.size() - 1);
    }
    return std::nullopt;
}

std::uint32_t RequestPrefetchPlan::Hash(std::string_view value) {
    std::uint32_t hash = 2166136261u;
    for (const unsigned char byte : value) {
        hash ^= byte;
        hash *= 16777619u;
    }
    return hash;
}

} // namespace swm
