#include "body_collection.h"

#include <utility>

namespace swm::binding {

BodyCollection::BodyCollection(std::size_t maximumSize) noexcept : maximumSize_(maximumSize) {}

bool BodyCollection::Completed() const noexcept {
    return completed_;
}

bool BodyCollection::Append(std::string_view chunk) {
    if (chunk.size() > maximumSize_ - bytes_.size()) {
        Discard();
        return false;
    }
    bytes_.insert(bytes_.end(), chunk.begin(), chunk.end());
    return true;
}

std::vector<char> BodyCollection::Take() {
    completed_ = true;
    return std::exchange(bytes_, {});
}

void BodyCollection::Discard() noexcept {
    completed_ = true;
    std::vector<char>().swap(bytes_);
}

} // namespace swm::binding
