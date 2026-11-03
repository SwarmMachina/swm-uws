#include "ephemeral_array_buffer.h"

namespace swm::binding {

EphemeralArrayBuffer::EphemeralArrayBuffer(v8::Isolate *isolate, v8::Local<v8::ArrayBuffer> buffer)
    : buffer_(buffer), detachKey_(v8::Null(isolate)) {
    // A non-undefined primitive blocks JS transfer without an old-to-young self reference.
    buffer_->SetDetachKey(detachKey_);
}

EphemeralArrayBuffer::~EphemeralArrayBuffer() {
    (void)buffer_->Detach(detachKey_);
}

v8::Local<v8::ArrayBuffer> EphemeralArrayBuffer::Value() const {
    return buffer_;
}

} // namespace swm::binding
