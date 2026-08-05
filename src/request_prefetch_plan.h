#ifndef SWM_UWS_REQUEST_PREFETCH_PLAN_H
#define SWM_UWS_REQUEST_PREFETCH_PLAN_H

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace swm {

class RequestPrefetchPlan final {
public:
    RequestPrefetchPlan(const void *environmentToken,
                        bool allHeaders,
                        std::vector<std::string> headerNames);

    [[nodiscard]] const void *EnvironmentToken() const;
    [[nodiscard]] bool SelectsAllHeaders() const;
    [[nodiscard]] const std::vector<std::string> &HeaderNames() const;
    [[nodiscard]] std::optional<std::uint16_t> Find(std::string_view lowercaseName) const;

private:
    struct CompiledName {
        std::uint32_t hash;
        std::uint16_t length;
    };

    static std::uint32_t Hash(std::string_view value);

    const void *environmentToken_;
    bool allHeaders_;
    std::vector<std::string> headerNames_;
    std::vector<CompiledName> compiledNames_;
    std::vector<std::int32_t> lookupTable_;
};

} // namespace swm

#endif // SWM_UWS_REQUEST_PREFETCH_PLAN_H
