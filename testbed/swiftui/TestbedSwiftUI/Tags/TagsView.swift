import SwiftUI

struct TagsView: View {

    @State private var model = TagsModel()

    var body: some View {
        List {
            ForEach(0..<model.total, id: \.self) { index in
                Label(model.tags[index].name, systemImage: "tag")
            }
        }
        .navigationTitle("Tags (\(model.total))")
        .onAppear { Telemetry.track("open_tags") }
    }
}
