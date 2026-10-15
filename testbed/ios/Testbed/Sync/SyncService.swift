import UIKit

struct Draft {
    let id: Int
    let text: String
}

/// Uploads the user's drafts. A background task lets an upload finish when the user leaves the app.
@MainActor
final class SyncService {

    private final class Upload {
        let total: Int
        var sent = 0

        init(total: Int) {
            self.total = total
        }
    }

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var upload: Upload?

    func start(completion: @escaping @MainActor (Int) -> Void) {
        let drafts = FakeBackend.drafts
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "sync") { [self] in
            // Out of background time: remember how far the upload got, to resume on the next launch.
            UserDefaults.standard.set(upload!.sent, forKey: "sync.sent")
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        upload = Upload(total: drafts.count)
        FakeBackend.upload(drafts) { [self] sent in
            upload = nil
            completion(sent)
        }
    }
}
