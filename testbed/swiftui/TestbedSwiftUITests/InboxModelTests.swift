import XCTest
@testable import TestbedSwiftUI

@MainActor
final class InboxModelTests: XCTestCase {

    func testHeadlineIsTheLatestMessage() async {
        let model = InboxModel(fetch: { [Message(id: 1, subject: "Welcome"), Message(id: 2, subject: "Older")] })

        await model.load()

        XCTAssertEqual(model.headline, "Latest: Welcome")
        XCTAssertEqual(model.messages.count, 2)
    }
}
