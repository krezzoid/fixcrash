import FirebaseCore
import UIKit

/// Sets up Firebase, as Firebase documents for SwiftUI apps.
final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Unit tests run inside the app: they report nothing to Firebase.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
            FirebaseApp.configure()
            Telemetry.setUserID("test-user-0001")
        }
        return true
    }
}
