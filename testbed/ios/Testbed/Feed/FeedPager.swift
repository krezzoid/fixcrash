struct FeedItem: Equatable {
    let id: Int
    let title: String
}

struct FeedPager {
    let items: [FeedItem]
    var pageSize = 10

    var pageCount: Int {
        (items.count + pageSize - 1) / pageSize
    }

    func page(_ index: Int) -> [FeedItem] {
        let start = index * pageSize
        return Array(items[start..<start + pageSize])
    }
}
