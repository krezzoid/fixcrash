import XCTest
@testable import Testbed

final class ProfileParserTests: XCTestCase {

    func testParsesFullProfile() throws {
        let json = Data("""
            {
              "id": "user-0002",
              "displayName": "Another User",
              "avatar": {"url": "https://example.com/a.png", "width": 64, "height": 64}
            }
            """.utf8)

        let profile = try ProfileParser().parse(json)

        XCTAssertEqual(
            profile,
            Profile(id: "user-0002", displayName: "Another User", avatarURL: URL(string: "https://example.com/a.png")!)
        )
    }
}
