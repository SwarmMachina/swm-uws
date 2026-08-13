#ifndef SWM_UWS_EPHEMERAL_ARRAY_BUFFER_H
#define SWM_UWS_EPHEMERAL_ARRAY_BUFFER_H

#include <v8.h>

namespace swm::binding {

class EphemeralArrayBuffer final {
public:
    explicit EphemeralArrayBuffer(v8::Local<v8::ArrayBuffer> buffer);
    ~EphemeralArrayBuffer();

    EphemeralArrayBuffer(const EphemeralArrayBuffer &) = delete;
    EphemeralArrayBuffer &operator=(const EphemeralArrayBuffer &) = delete;

    [[nodiscard]] v8::Local<v8::ArrayBuffer> Value() const;

private:
    v8::Local<v8::ArrayBuffer> buffer_;
};

} // namespace swm::binding

#endif // SWM_UWS_EPHEMERAL_ARRAY_BUFFER_H
