import Foundation

/// Canned responses in place of a network backend. All values are synthetic.
enum FakeBackend {

    /// The tags endpoint counts five tags, but two of them were retired and no longer come back.
    static let tags = TagsResponse(total: 5, tags: [
        Tag(id: 1, name: "swift"),
        Tag(id: 2, name: "crashes"),
        Tag(id: 3, name: "testing"),
    ])

    /// A new account's inbox: empty, after a network round trip.
    static func messages() async -> [Message] {
        try? await Task.sleep(for: .milliseconds(200))
        return []
    }

    static let drafts = (1...3).map { Draft(id: $0, title: "Draft #\($0)") }
}
