import SwiftUI

enum Screen: String, CaseIterable, Hashable {
    case tags, inbox, archive

    var title: String { rawValue.capitalized }
}

struct ContentView: View {

    @State private var path: [Screen]

    init(screen: Screen? = nil) {
        _path = State(initialValue: screen.map { [$0] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            List(Screen.allCases, id: \.self) { screen in
                NavigationLink(screen.title, value: screen)
            }
            .navigationTitle("fixcrash SwiftUI")
            .navigationDestination(for: Screen.self) { screen in
                switch screen {
                case .tags: TagsView()
                case .inbox: InboxView()
                case .archive: ArchiveView()
                }
            }
        }
    }
}
