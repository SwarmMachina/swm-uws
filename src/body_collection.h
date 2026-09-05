#ifndef SWM_UWS_BODY_COLLECTION_H
#define SWM_UWS_BODY_COLLECTION_H

#include <cstddef>
#include <string_view>
#include <vector>

namespace swm::binding {

class BodyCollection final {
public:
    explicit BodyCollection(std::size_t maximumSize) noexcept;
    [[nodiscard]] bool Completed() const noexcept;
    [[nodiscard]] bool Append(std::string_view chunk);
    [[nodiscard]] std::vector<char> Take();
    void Discard() noexcept;

private:
    std::size_t maximumSize_;
    bool completed_ = false;
    std::vector<char> bytes_;
};

} // namespace swm::binding
#endif
