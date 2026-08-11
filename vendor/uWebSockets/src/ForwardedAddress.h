/*
 * SwarmMachina trusted-ingress forwarded-address parser.
 *
 * Licensed under the Apache License, Version 2.0.
 */

#ifndef UWS_FORWARDEDADDRESS_H
#define UWS_FORWARDEDADDRESS_H

#ifdef _WIN32
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#endif

#include <array>
#include <cstddef>
#include <cstring>
#include <string_view>

#include "HttpTransportConfig.h"

namespace uWS {

class ForwardedAddress final {
public:
    void reset() noexcept {
        length_ = 0;
    }

    [[nodiscard]] bool assign(
        TrustedProxyHeader header,
        unsigned int hops,
        std::string_view value) noexcept {
        reset();

        if (header == TrustedProxyHeader::None) {
            return true;
        }

        if (header == TrustedProxyHeader::XRealIp) {
            return parseAddress(trimOws(value));
        }

        std::string_view remaining = value;
        for (unsigned int hop = 1; hop <= hops; hop++) {
            remaining = trimOws(remaining);
            if (remaining.empty()) {
                return false;
            }

            const std::size_t comma = remaining.rfind(',');
            const std::string_view candidate = trimOws(
                comma == std::string_view::npos
                    ? remaining
                    : remaining.substr(comma + 1));

            /* Every skipped entry is a nearer trusted hop and must itself be valid. */
            if (!parseAddress(candidate)) {
                return false;
            }
            if (hop == hops) {
                return true;
            }
            if (comma == std::string_view::npos) {
                return false;
            }
            remaining = remaining.substr(0, comma);
        }

        return false;
    }

    [[nodiscard]] std::string_view bytes() const noexcept {
        return {reinterpret_cast<const char *>(bytes_.data()), length_};
    }

private:
    [[nodiscard]] static std::string_view trimOws(std::string_view value) noexcept {
        while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
            value.remove_prefix(1);
        }
        while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) {
            value.remove_suffix(1);
        }
        return value;
    }

    [[nodiscard]] bool parseAddress(std::string_view value) noexcept {
        /* Longest RFC 4291 text form is 45 bytes, excluding the terminator. */
        std::array<char, 46> text{};
        if (value.empty() || value.size() >= text.size()) {
            return false;
        }
        std::memcpy(text.data(), value.data(), value.size());

        std::array<unsigned char, 16> parsed{};
        if (inet_pton(AF_INET, text.data(), parsed.data()) == 1) {
            bytes_ = parsed;
            length_ = 4;
            return true;
        }
        if (inet_pton(AF_INET6, text.data(), parsed.data()) == 1) {
            bytes_ = parsed;
            length_ = 16;
            return true;
        }
        return false;
    }

    std::array<unsigned char, 16> bytes_{};
    std::size_t length_ = 0;
};

}  // namespace uWS

#endif  // UWS_FORWARDEDADDRESS_H
