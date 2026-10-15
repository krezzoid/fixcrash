import XCTest
@testable import TestbedSwiftUI

@MainActor
final class TagsModelTests: XCTestCase {

    func testKeepsTheResponse() {
        let tags = [Tag(id: 7, name: "a"), Tag(id: 8, name: "b")]

        let model = TagsModel(response: TagsResponse(total: 2, tags: tags))

        XCTAssertEqual(model.total, 2)
        XCTAssertEqual(model.tags, tags)
    }
}
