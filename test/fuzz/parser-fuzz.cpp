#include "ChunkedEncoding.h"
#include "TopicTree.h"
#include "WebSocketProtocol.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <vector>

namespace {

constexpr std::size_t MAX_SPLIT_INPUT = 4096;
constexpr std::uint64_t MAX_FUZZED_WEBSOCKET_PAYLOAD = 1024 * 1024;

void verifyTopicTreeMessagePaletteReentrancy() {
    using TopicTree = uWS::TopicTree<int, int>;

    TopicTree *topicTree = nullptr;
    uWS::Subscriber *outerSubscriber = nullptr;
    uWS::Subscriber *nestedSubscriber = nullptr;
    int callbackCount = 0;
    bool nestedDrainStopped = false;

    TopicTree tree([&](uWS::Subscriber *subscriber, int &, TopicTree::IteratorFlags) {
        callbackCount++;
        if (subscriber == outerSubscriber && callbackCount == 1) {
            nestedDrainStopped = topicTree->drain(nestedSubscriber);
        }
        return false;
    });
    topicTree = &tree;
    outerSubscriber = tree.createSubscriber();
    nestedSubscriber = tree.createSubscriber();

    tree.subscribe(outerSubscriber, "topic");
    tree.subscribe(nestedSubscriber, "topic");
    if (!tree.publish(nullptr, "topic", 1) || !tree.publish(nullptr, "topic", 2)) {
        __builtin_trap();
    }

    bool outerDrainStopped = tree.drain(outerSubscriber);
    if (!outerDrainStopped || nestedDrainStopped || callbackCount != 3) {
        __builtin_trap();
    }

    tree.freeSubscriber(outerSubscriber);
    tree.freeSubscriber(nestedSubscriber);
}

void fuzzChunkedContiguous(const std::uint8_t *data, std::size_t size) {
    const char empty = 0;
    std::string_view remaining(size ? reinterpret_cast<const char *>(data) : &empty, size);
    std::uint64_t state = uWS::STATE_IS_CHUNKED;
    std::size_t emitted = 0;

    for (std::size_t iteration = 0; iteration <= size + 1; iteration++) {
        const std::size_t before = remaining.size();
        auto chunk = uWS::getNextChunk(remaining, state);

        if (chunk) {
            emitted += chunk->size();
            if (emitted > size) {
                __builtin_trap();
            }
        } else if (remaining.size() == before) {
            return;
        }

        if (!state || uWS::isParsingInvalidChunkedEncoding(state)) {
            return;
        }
    }

    __builtin_trap();
}

void fuzzChunkedByteSplit(const std::uint8_t *data, std::size_t size) {
    std::uint64_t state = uWS::STATE_IS_CHUNKED;
    std::size_t emitted = 0;

    for (std::size_t index = 0; index < std::min(size, MAX_SPLIT_INPUT); index++) {
        std::string_view remaining(reinterpret_cast<const char *>(data + index), 1);

        for (unsigned int iteration = 0; iteration < 3; iteration++) {
            const std::size_t before = remaining.size();
            auto chunk = uWS::getNextChunk(remaining, state);

            if (chunk) {
                emitted += chunk->size();
                if (emitted > size) {
                    __builtin_trap();
                }
            } else if (remaining.size() == before) {
                break;
            }

            if (!state || uWS::isParsingInvalidChunkedEncoding(state)) {
                return;
            }
        }
    }
}

struct WebSocketFuzzUser {
    bool closed = false;
    std::uint64_t handledBytes = 0;
};

struct WebSocketFuzzImplementation {
    static bool setCompressed(uWS::WebSocketState<true> *, void *) {
        return true;
    }

    static void forceClose(uWS::WebSocketState<true> *, void *user, std::string_view = {}) {
        static_cast<WebSocketFuzzUser *>(user)->closed = true;
    }

    static bool handleFragment(char *,
                               std::size_t length,
                               unsigned int,
                               int,
                               bool,
                               uWS::WebSocketState<true> *,
                               void *user) {
        auto *fuzzUser = static_cast<WebSocketFuzzUser *>(user);
        fuzzUser->handledBytes += length;
        return fuzzUser->handledBytes > MAX_FUZZED_WEBSOCKET_PAYLOAD;
    }

    static bool refusePayloadLength(std::uint64_t length, uWS::WebSocketState<true> *, void *) {
        return length > MAX_FUZZED_WEBSOCKET_PAYLOAD;
    }
};

using FuzzedWebSocketProtocol = uWS::WebSocketProtocol<true, WebSocketFuzzImplementation>;

constexpr std::size_t WEBSOCKET_PRE_PADDING = FuzzedWebSocketProtocol::CONSUME_PRE_PADDING;
constexpr std::size_t WEBSOCKET_POST_PADDING = 32;

void consumeWebSocketSegment(const std::uint8_t *data,
                             std::size_t size,
                             uWS::WebSocketState<true> &state,
                             WebSocketFuzzUser &user) {
    std::vector<char> buffer(WEBSOCKET_PRE_PADDING + size + WEBSOCKET_POST_PADDING);

    if (size) {
        std::memcpy(buffer.data() + WEBSOCKET_PRE_PADDING, data, size);
    }
    FuzzedWebSocketProtocol::consume(
        buffer.data() + WEBSOCKET_PRE_PADDING, static_cast<unsigned int>(size), &state, &user);
}

void fuzzWebSocketContiguous(const std::uint8_t *data, std::size_t size) {
    uWS::WebSocketState<true> state;
    WebSocketFuzzUser user;

    consumeWebSocketSegment(data, size, state, user);
}

void fuzzWebSocketByteSplit(const std::uint8_t *data, std::size_t size) {
    uWS::WebSocketState<true> state;
    WebSocketFuzzUser user;
    std::array<char, WEBSOCKET_PRE_PADDING + 1 + WEBSOCKET_POST_PADDING> buffer{};

    for (std::size_t index = 0; index < std::min(size, MAX_SPLIT_INPUT) && !user.closed; index++) {
        buffer[WEBSOCKET_PRE_PADDING] = static_cast<char>(data[index]);
        FuzzedWebSocketProtocol::consume(buffer.data() + WEBSOCKET_PRE_PADDING, 1, &state, &user);
    }
}

} // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t *data, std::size_t size) {
    static const bool verifiedTopicTreeReentrancy = [] {
        verifyTopicTreeMessagePaletteReentrancy();
        return true;
    }();
    (void)verifiedTopicTreeReentrancy;

    fuzzChunkedContiguous(data, size);
    fuzzChunkedByteSplit(data, size);
    fuzzWebSocketContiguous(data, size);
    fuzzWebSocketByteSplit(data, size);
    return 0;
}
