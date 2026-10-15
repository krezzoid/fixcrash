import SwiftUI

struct Draft: Identifiable, Equatable {
    let id: Int
    let title: String
}

struct ArchiveView: View {

    @State private var drafts = FakeBackend.drafts
    @State private var selected: Draft?
    @State private var archived: [Draft] = []

    var body: some View {
        List(drafts) { draft in
            Button {
                selected = draft
            } label: {
                Label(draft.title, systemImage: selected == draft ? "checkmark.circle.fill" : "circle")
            }
        }
        .navigationTitle("Archive (\(archived.count))")
        .toolbar {
            Button("Archive") {
                Telemetry.track("archive")
                archived.append(selected!)
                drafts.removeAll { $0 == selected }
                selected = nil
            }
        }
    }
}
