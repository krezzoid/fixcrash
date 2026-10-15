import Foundation

/// Canned responses in place of a network backend. All values are synthetic.
enum FakeBackend {

    static let profileJSON = Data(#"{"id":"user-0001","displayName":"Test User"}"#.utf8)

    static let feed = (1...23).map { FeedItem(id: $0, title: "Post #\($0)") }

    static let drafts = (1...3).map { Draft(id: $0, text: "Draft #\($0)") }

    /// Uploads drafts and reports how many were sent, half a second later, as a network call would.
    static func upload(_ drafts: [Draft], completion: @escaping @MainActor (Int) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            completion(drafts.count)
        }
    }
}
