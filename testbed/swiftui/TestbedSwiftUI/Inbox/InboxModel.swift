import Observation

struct Message: Identifiable, Equatable {
    let id: Int
    let subject: String
}

@Observable
final class InboxModel {
    private(set) var messages: [Message] = []
    private(set) var headline = ""

    private let fetch: () async -> [Message]

    init(fetch: @escaping () async -> [Message] = FakeBackend.messages) {
        self.fetch = fetch
    }

    func load() async {
        Telemetry.track("load_inbox")
        let messages = await fetch()
        self.messages = messages
        headline = "Latest: \(messages.first!.subject)"
    }
}
