import FirebaseAnalytics
import FirebaseCore
import FirebaseCrashlytics

/// Crashlytics and Analytics calls. They do nothing when Firebase is not configured, as in unit tests.
enum Telemetry {

    private static var crashlytics: Crashlytics? {
        FirebaseApp.app() == nil ? nil : Crashlytics.crashlytics()
    }

    static func setUserID(_ id: String) {
        crashlytics?.setUserID(id)
    }

    static func setValue(_ value: Any, forKey key: String) {
        crashlytics?.setCustomValue(value, forKey: key)
    }

    /// A user action: a Crashlytics log line, a custom key and an Analytics event (a breadcrumb).
    static func track(_ action: String) {
        guard let crashlytics else { return }
        crashlytics.log("action: \(action)")
        crashlytics.setCustomValue(action, forKey: "last_action")
        Analytics.logEvent(action, parameters: nil)
    }
}
