import SwiftUI

struct InboxView: View {

    @State private var model = InboxModel()

    var body: some View {
        List(model.messages) { message in
            Text(message.subject)
        }
        .navigationTitle(model.headline)
        .task { await model.load() }
    }
}
