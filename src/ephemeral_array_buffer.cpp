#include "ephemeral_array_buffer.h"

namespace swm::binding {

EphemeralArrayBuffer::EphemeralArrayBuffer(v8::Local<v8::ArrayBuffer> buffer) : buffer_(buffer) {
    buffer_->SetDetachKey(buffer_);
}

EphemeralArrayBuffer::~EphemeralArrayBuffer() {
    if (!buffer_->WasDetached()) {
        (void)buffer_->Detach(buffer_);
    }
}

v8::Local<v8::ArrayBuffer> EphemeralArrayBuffer::Value() const {
    return buffer_;
}

} // namespace swm::binding
