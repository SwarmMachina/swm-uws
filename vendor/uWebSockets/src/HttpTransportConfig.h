/*
 * SwarmMachina transport-policy extension for vendored uWebSockets.
 *
 * Licensed under the Apache License, Version 2.0.
 */

#ifndef UWS_HTTPTRANSPORTCONFIG_H
#define UWS_HTTPTRANSPORTCONFIG_H

#include "libusockets.h"

#include <cstddef>
#include <cstdint>
#include <optional>

namespace uWS {

inline constexpr std::size_t MAX_HEADER_COUNT_CAPACITY = 100;

enum class HttpTransportPhase : std::uint8_t {
    HeadersReading,
    HandlerResponse,
    BodyReading,
    ResponseBlocked,
    KeepAliveIdle,
};

enum class TrustedProxyHeader : std::uint8_t {
    None,
    XForwardedFor,
    XRealIp,
};

class HttpTransportConfig final {
public:
    static constexpr std::size_t DEFAULT_MAX_HEADER_SIZE = 4096;
    static constexpr std::uint16_t DEFAULT_MAX_HEADER_COUNT = 100;
    static constexpr std::uint32_t DEFAULT_HEADERS_TIMEOUT_MS = 10000;
    static constexpr std::uint32_t DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 10000;
    static constexpr std::uint32_t DEFAULT_BODY_IDLE_TIMEOUT_MS = 10000;
    static constexpr std::uint32_t DEFAULT_MIN_BODY_RATE_BYTES_PER_SEC = 16384;
    static constexpr std::uint32_t DEFAULT_RESPONSE_WRITE_TIMEOUT_MS = 10000;
    /*
     * The uSockets short timeout wheel has 240 four-second slots. Explicit
     * millisecond deadlines add one full slot before rounding so they cannot
     * expire early. 956 seconds is therefore the largest requested deadline
     * that remains representable without wrapping the wheel.
     */
    static constexpr std::uint32_t MAX_EXPLICIT_TIMEOUT_MS = 956000;

    HttpTransportConfig(
        std::size_t maxHeaderSize = DEFAULT_MAX_HEADER_SIZE,
        std::uint16_t maxHeaderCount = DEFAULT_MAX_HEADER_COUNT,
        std::uint32_t headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
        std::uint32_t keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
        std::uint32_t bodyIdleTimeoutMs = DEFAULT_BODY_IDLE_TIMEOUT_MS,
        std::optional<std::uint32_t> minBodyRateBytesPerSec =
            DEFAULT_MIN_BODY_RATE_BYTES_PER_SEC,
        std::uint32_t responseWriteTimeoutMs = DEFAULT_RESPONSE_WRITE_TIMEOUT_MS,
        TrustedProxyHeader trustedProxyHeader = TrustedProxyHeader::None,
        std::uint8_t trustedProxyHops = 1,
        bool headersTimeoutExplicit = false,
        bool keepAliveTimeoutExplicit = false,
        bool bodyIdleTimeoutExplicit = false,
        bool responseWriteTimeoutExplicit = false)
        : maxHeaderSize(maxHeaderSize),
          maxHeaderCount(maxHeaderCount),
          headersTimeoutMs(headersTimeoutMs),
          keepAliveTimeoutMs(keepAliveTimeoutMs),
          bodyIdleTimeoutMs(bodyIdleTimeoutMs),
          minBodyRateBytesPerSec(minBodyRateBytesPerSec),
          responseWriteTimeoutMs(responseWriteTimeoutMs),
          trustedProxyHeader(trustedProxyHeader),
          trustedProxyHops(trustedProxyHops),
          headersTimeoutSeconds(
              ComputeTimeoutSeconds(headersTimeoutMs, headersTimeoutExplicit)),
          keepAliveTimeoutSeconds(
              ComputeTimeoutSeconds(keepAliveTimeoutMs, keepAliveTimeoutExplicit)),
          bodyIdleTimeoutSeconds(
              ComputeTimeoutSeconds(bodyIdleTimeoutMs, bodyIdleTimeoutExplicit)),
          responseWriteTimeoutSeconds(
              ComputeTimeoutSeconds(
                  responseWriteTimeoutMs,
                  responseWriteTimeoutExplicit)),
          bodyRateResetThresholdBytes(
              ComputeBodyRateResetThreshold(
                  minBodyRateBytesPerSec,
                  bodyIdleTimeoutMs)) {}

    const std::size_t maxHeaderSize;
    const std::uint16_t maxHeaderCount;
    const std::uint32_t headersTimeoutMs;
    const std::uint32_t keepAliveTimeoutMs;
    const std::uint32_t bodyIdleTimeoutMs;
    const std::optional<std::uint32_t> minBodyRateBytesPerSec;
    const std::uint32_t responseWriteTimeoutMs;
    const TrustedProxyHeader trustedProxyHeader;
    const std::uint8_t trustedProxyHops;
    const unsigned int headersTimeoutSeconds;
    const unsigned int keepAliveTimeoutSeconds;
    const unsigned int bodyIdleTimeoutSeconds;
    const unsigned int responseWriteTimeoutSeconds;
    const std::uint64_t bodyRateResetThresholdBytes;

private:
    [[nodiscard]] static unsigned int ComputeTimeoutSeconds(
        std::uint32_t timeoutMs,
        bool explicitTimeout) {
        if (!explicitTimeout) {
            return static_cast<unsigned int>(
                (static_cast<std::uint64_t>(timeoutMs) + 999) / 1000);
        }

        /*
         * uSockets uses a four-second timeout wheel. Add one complete wheel
         * interval before rounding so a configured deadline is never shortened
         * by the position of the next sweep. Actual expiry is therefore up to
         * eight seconds later than the requested millisecond value.
         */
        const std::uint64_t requestedSeconds =
            (static_cast<std::uint64_t>(timeoutMs) + 999) / 1000;
        const std::uint64_t safeSeconds =
            requestedSeconds + LIBUS_TIMEOUT_GRANULARITY;
        return safeSeconds > UINT32_MAX
            ? UINT32_MAX
            : static_cast<unsigned int>(safeSeconds);
    }

    [[nodiscard]] static std::uint64_t ComputeBodyRateResetThreshold(
        std::optional<std::uint32_t> minimumRate,
        std::uint32_t timeoutMs) {
        return minimumRate
            ? (static_cast<std::uint64_t>(*minimumRate) * timeoutMs + 999) / 1000
            : 1;
    }
};

struct HttpTransportStats {
    std::uint64_t activeConnections = 0;
    std::uint64_t headerTooLarge = 0;
    std::uint64_t headerCountExceeded = 0;
    std::uint64_t headerTimeouts = 0;
    std::uint64_t bodyTimeouts = 0;
    std::uint64_t bodyRateViolations = 0;
    std::uint64_t responseWriteTimeouts = 0;
};

}  // namespace uWS

#endif  // UWS_HTTPTRANSPORTCONFIG_H
