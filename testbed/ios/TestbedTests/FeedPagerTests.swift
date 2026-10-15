import XCTest
@testable import Testbed

final class FeedPagerTests: XCTestCase {

    private func items(_ count: Int) -> [FeedItem] {
        (1...count).map { FeedItem(id: $0, title: "Post #\($0)") }
    }

    func testCountsPartialPage() {
        XCTAssertEqual(FeedPager(items: items(23), pageSize: 10).pageCount, 3)
    }

    func testReturnsFullPage() {
        let page = FeedPager(items: items(20), pageSize: 10).page(1)

        XCTAssertEqual(page.map(\.id), Array(11...20))
    }
}
