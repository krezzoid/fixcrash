import Observation

struct Tag: Identifiable, Equatable {
    let id: Int
    let name: String
}

struct TagsResponse {
    /// How many tags the account has, as the backend counts them.
    let total: Int
    let tags: [Tag]
}

@Observable
final class TagsModel {
    private(set) var total: Int
    private(set) var tags: [Tag]

    init(response: TagsResponse = FakeBackend.tags) {
        total = response.total
        tags = response.tags
    }
}
