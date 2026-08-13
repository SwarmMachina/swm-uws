#ifndef SWM_UWS_RESPONSE_CALLBACK_LIFETIME_H
#define SWM_UWS_RESPONSE_CALLBACK_LIFETIME_H

namespace swm::binding {

class AppState;

class ResponseCallbackLifetime final {
public:
    explicit ResponseCallbackLifetime(AppState *app) noexcept;

    ResponseCallbackLifetime(const ResponseCallbackLifetime &) = delete;
    ResponseCallbackLifetime &operator=(const ResponseCallbackLifetime &) = delete;

    [[nodiscard]] bool IsActive() const noexcept;
    void Invalidate() noexcept;

private:
    AppState *app_;
    bool active_ = true;
};

} // namespace swm::binding

#endif // SWM_UWS_RESPONSE_CALLBACK_LIFETIME_H
