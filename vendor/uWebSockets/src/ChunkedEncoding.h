/*
 * Authored by Alex Hultman, 2018-2026.
 * Intellectual property of third-party.

 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef UWS_CHUNKEDENCODING_H
#define UWS_CHUNKEDENCODING_H

/* Independent chunked encoding parser, used by HttpParser. */

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <string_view>

namespace uWS {

/* The high nibble stores the parser phase while the low 60 bits store
 * either the parsed chunk size, the remaining chunk data, or a small
 * trailer sub-state. This preserves the previous maximum chunk size. */
constexpr uint64_t STATE_VALUE_MASK = 0x0FFFFFFFFFFFFFFFull;
constexpr uint64_t STATE_PHASE_MASK = ~STATE_VALUE_MASK;

constexpr uint64_t STATE_SIZE_START = 0x1000000000000000ull;
constexpr uint64_t STATE_SIZE = 0x2000000000000000ull;
constexpr uint64_t STATE_EXTENSION_SEPARATOR = 0x3000000000000000ull;
constexpr uint64_t STATE_EXTENSION_NAME_START = 0x4000000000000000ull;
constexpr uint64_t STATE_EXTENSION_NAME = 0x5000000000000000ull;
constexpr uint64_t STATE_EXTENSION_AFTER_NAME = 0x6000000000000000ull;
constexpr uint64_t STATE_EXTENSION_VALUE_START = 0x7000000000000000ull;
constexpr uint64_t STATE_EXTENSION_TOKEN_VALUE = 0x8000000000000000ull;
constexpr uint64_t STATE_EXTENSION_AFTER_VALUE = 0x9000000000000000ull;
constexpr uint64_t STATE_EXTENSION_QUOTED_VALUE = 0xA000000000000000ull;
constexpr uint64_t STATE_EXTENSION_QUOTED_PAIR = 0xB000000000000000ull;
constexpr uint64_t STATE_SIZE_LF = 0xC000000000000000ull;
constexpr uint64_t STATE_DATA = 0xD000000000000000ull;
constexpr uint64_t STATE_DATA_CRLF = 0xE000000000000000ull;
constexpr uint64_t STATE_TRAILER = 0xF000000000000000ull;

/* HttpParser initializes chunked parsing with this public sentinel. */
constexpr uint64_t STATE_IS_CHUNKED = STATE_SIZE_START;
constexpr uint64_t STATE_IS_ERROR = ~0ull;

constexpr uint64_t TRAILER_LINE_START = 0;
constexpr uint64_t TRAILER_NAME = 1;
constexpr uint64_t TRAILER_VALUE = 2;
constexpr uint64_t TRAILER_LINE_LF = 3;
constexpr uint64_t TRAILER_END_LF = 4;

inline uint64_t chunkSize(uint64_t state) {
    return state & STATE_VALUE_MASK;
}

inline uint64_t parserPhase(uint64_t state) {
    return state & STATE_PHASE_MASK;
}

inline bool isHexDigit(unsigned char c) {
    return ((c >= '0') & (c <= '9')) | ((c >= 'A') & (c <= 'F')) | ((c >= 'a') & (c <= 'f'));
}

inline unsigned int hexDigitValue(unsigned char c) {
    if (c <= '9') {
        return (unsigned int)c - (unsigned int)'0';
    }
    return ((unsigned int)c | 32u) - (unsigned int)'a' + 10u;
}

/* RFC 9110 Section 5.6.2, token = 1*tchar. */
inline bool isTokenCharacter(unsigned char c) {
    if (((c >= 'a') & (c <= 'z')) | ((c >= 'A') & (c <= 'Z')) | ((c >= '0') & (c <= '9'))) {
        return true;
    }

    switch (c) {
    case '!':
    case '#':
    case '$':
    case '%':
    case '&':
    case '\'':
    case '*':
    case '+':
    case '-':
    case '.':
    case '^':
    case '_':
    case '`':
    case '|':
    case '~':
        return true;
    default:
        return false;
    }
}

inline bool isBadWhitespace(unsigned char c) {
    return (c == ' ') | (c == '\t');
}

/* RFC 9110 Section 5.6.4, qdtext. DQUOTE and backslash are handled by
 * the quoted-string state machine itself. */
inline bool isQuotedText(unsigned char c) {
    return (c == '\t') | (c == ' ') | (c == '!') | ((c >= '#') & (c <= '[')) |
           ((c >= ']') & (c <= '~')) | (c >= 0x80);
}

/* RFC 9110 Section 5.6.4, quoted-pair payload. */
inline bool isQuotedPairCharacter(unsigned char c) {
    return (c == '\t') | ((c >= ' ') & (c <= '~')) | (c >= 0x80);
}

/* field-line values can contain HTAB, SP, VCHAR, and obs-text. CRLF is
 * parsed separately and all other controls, including NUL and DEL, fail. */
inline bool isFieldValueCharacter(unsigned char c) {
    return (c == '\t') | ((c >= ' ') & (c <= '~')) | (c >= 0x80);
}

inline void failChunkedEncoding(uint64_t &state) {
    state = STATE_IS_ERROR;
}

/* Are we in the middle of parsing chunked encoding? */
inline bool isParsingChunkedEncoding(uint64_t state) {
    return (state & STATE_PHASE_MASK) != 0;
}

inline bool isParsingInvalidChunkedEncoding(uint64_t state) {
    return state == STATE_IS_ERROR;
}

/* Returns the next decoded data span. An empty span is returned only once
 * the last-chunk, optional trailers, and final CRLF have all been validated.
 * nullopt means that more input is required or parsing has completed. */
static std::optional<std::string_view>
getNextChunk(std::string_view &data, uint64_t &state, bool trailer = false) {
    (void)trailer;

    if (!state || isParsingInvalidChunkedEncoding(state)) {
        return std::nullopt;
    }

    while (data.length()) {
        unsigned char c = (unsigned char)data[0];
        uint64_t phase = parserPhase(state);
        uint64_t value = chunkSize(state);

        if (phase == STATE_SIZE_START) {
            if (!isHexDigit(c)) [[unlikely]] {
                failChunkedEncoding(state);
                return std::nullopt;
            }

            state = STATE_SIZE | hexDigitValue(c);
            data.remove_prefix(1);
            continue;
        }

        if (phase == STATE_SIZE) {
            if (isHexDigit(c)) [[likely]] {
                unsigned int digit = hexDigitValue(c);

                if (value > (STATE_VALUE_MASK - digit) / 16ull) [[unlikely]] {
                    failChunkedEncoding(state);
                    return std::nullopt;
                }

                state = STATE_SIZE | (value * 16ull + digit);
                data.remove_prefix(1);
                continue;
            }
            if (c == '\r') [[likely]] {
                state = STATE_SIZE_LF | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (isBadWhitespace(c)) {
                state = STATE_EXTENSION_SEPARATOR | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_SEPARATOR) {
            if (isBadWhitespace(c)) {
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_NAME_START) {
            if (isBadWhitespace(c)) {
                data.remove_prefix(1);
                continue;
            }
            if (isTokenCharacter(c)) {
                state = STATE_EXTENSION_NAME | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_NAME) {
            if (isTokenCharacter(c)) [[likely]] {
                data.remove_prefix(1);
                continue;
            }
            if (c == '=') {
                state = STATE_EXTENSION_VALUE_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == '\r') {
                state = STATE_SIZE_LF | value;
                data.remove_prefix(1);
                continue;
            }
            if (isBadWhitespace(c)) {
                state = STATE_EXTENSION_AFTER_NAME | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_AFTER_NAME) {
            if (isBadWhitespace(c)) {
                data.remove_prefix(1);
                continue;
            }
            if (c == '=') {
                state = STATE_EXTENSION_VALUE_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_VALUE_START) {
            if (isBadWhitespace(c)) {
                data.remove_prefix(1);
                continue;
            }
            if (isTokenCharacter(c)) {
                state = STATE_EXTENSION_TOKEN_VALUE | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == '"') {
                state = STATE_EXTENSION_QUOTED_VALUE | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_TOKEN_VALUE) {
            if (isTokenCharacter(c)) [[likely]] {
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == '\r') {
                state = STATE_SIZE_LF | value;
                data.remove_prefix(1);
                continue;
            }
            if (isBadWhitespace(c)) {
                state = STATE_EXTENSION_AFTER_VALUE | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_AFTER_VALUE) {
            if (isBadWhitespace(c)) {
                data.remove_prefix(1);
                continue;
            }
            if (c == ';') {
                state = STATE_EXTENSION_NAME_START | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == '\r') {
                state = STATE_SIZE_LF | value;
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_QUOTED_VALUE) {
            if (c == '"') {
                state = STATE_EXTENSION_AFTER_VALUE | value;
                data.remove_prefix(1);
                continue;
            }
            if (c == '\\') {
                state = STATE_EXTENSION_QUOTED_PAIR | value;
                data.remove_prefix(1);
                continue;
            }
            if (isQuotedText(c)) {
                data.remove_prefix(1);
                continue;
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        if (phase == STATE_EXTENSION_QUOTED_PAIR) {
            if (!isQuotedPairCharacter(c)) [[unlikely]] {
                failChunkedEncoding(state);
                return std::nullopt;
            }

            state = STATE_EXTENSION_QUOTED_VALUE | value;
            data.remove_prefix(1);
            continue;
        }

        if (phase == STATE_SIZE_LF) {
            if (c != '\n') [[unlikely]] {
                failChunkedEncoding(state);
                return std::nullopt;
            }

            state = value ? STATE_DATA | value : STATE_TRAILER | TRAILER_LINE_START;
            data.remove_prefix(1);
            continue;
        }

        if (phase == STATE_DATA) {
            size_t emittable = (size_t)std::min<uint64_t>(value, data.length());
            std::string_view emitSoon = data.substr(0, emittable);

            data.remove_prefix(emittable);
            state = emittable == value ? STATE_DATA_CRLF : STATE_DATA | (value - emittable);
            return emitSoon;
        }

        if (phase == STATE_DATA_CRLF) {
            if (value == 0) {
                if (c != '\r') [[unlikely]] {
                    failChunkedEncoding(state);
                    return std::nullopt;
                }

                state = STATE_DATA_CRLF | 1;
                data.remove_prefix(1);
                continue;
            }
            if (c != '\n') [[unlikely]] {
                failChunkedEncoding(state);
                return std::nullopt;
            }

            state = STATE_SIZE_START;
            data.remove_prefix(1);
            continue;
        }

        if (phase == STATE_TRAILER) {
            if (value == TRAILER_LINE_START) {
                if (c == '\r') {
                    state = STATE_TRAILER | TRAILER_END_LF;
                    data.remove_prefix(1);
                    continue;
                }
                if (isTokenCharacter(c)) {
                    state = STATE_TRAILER | TRAILER_NAME;
                    data.remove_prefix(1);
                    continue;
                }
            } else if (value == TRAILER_NAME) {
                if (isTokenCharacter(c)) [[likely]] {
                    data.remove_prefix(1);
                    continue;
                }
                if (c == ':') {
                    state = STATE_TRAILER | TRAILER_VALUE;
                    data.remove_prefix(1);
                    continue;
                }
            } else if (value == TRAILER_VALUE) {
                if (c == '\r') {
                    state = STATE_TRAILER | TRAILER_LINE_LF;
                    data.remove_prefix(1);
                    continue;
                }
                if (isFieldValueCharacter(c)) {
                    data.remove_prefix(1);
                    continue;
                }
            } else if (value == TRAILER_LINE_LF) {
                if (c == '\n') {
                    state = STATE_TRAILER | TRAILER_LINE_START;
                    data.remove_prefix(1);
                    continue;
                }
            } else if (value == TRAILER_END_LF && c == '\n') {
                state = 0;
                data.remove_prefix(1);
                return std::string_view(nullptr, 0);
            }

            failChunkedEncoding(state);
            return std::nullopt;
        }

        failChunkedEncoding(state);
        return std::nullopt;
    }

    return std::nullopt;
}

/* This is really just a wrapper for convenience */
struct ChunkIterator {

    std::string_view *data;
    std::optional<std::string_view> chunk;
    uint64_t *state;
    bool trailer;

    ChunkIterator(std::string_view *data, uint64_t *state, bool trailer = false)
        : data(data), state(state), trailer(trailer) {
        chunk = uWS::getNextChunk(*data, *state, trailer);
    }

    ChunkIterator() {}

    ChunkIterator begin() {
        return *this;
    }

    ChunkIterator end() {
        return ChunkIterator();
    }

    std::string_view operator*() {
        if (!chunk.has_value()) {
            std::abort();
        }
        return chunk.value();
    }

    bool operator!=(const ChunkIterator &other) const {
        return other.chunk.has_value() != chunk.has_value();
    }

    ChunkIterator &operator++() {
        chunk = uWS::getNextChunk(*data, *state, trailer);
        return *this;
    }
};
} // namespace uWS

#endif // UWS_CHUNKEDENCODING_H
