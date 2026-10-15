import SwiftUI

@main
struct TestbedApp: App {

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            // Lets simctl open a screen: `xcrun simctl launch <device> <bundle id> -screen <name>`.
            ContentView(screen: UserDefaults.standard.string(forKey: "screen").flatMap(Screen.init(rawValue:)))
        }
    }
}
