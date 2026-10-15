import UIKit

final class MainViewController: UIViewController {

    private static let syntheticUserID = "test-user-0001"

    private let feedPager = FeedPager(items: FakeBackend.feed)
    private let sync = SyncService()
    private var nextPage = 0
    private var ranScenario = false
    private let status = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "fixcrash testbed"
        view.backgroundColor = .systemBackground
        Telemetry.setUserID(Self.syntheticUserID)

        status.numberOfLines = 0
        status.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [
            button("Open profile") { $0.openProfile() },
            button("Load more") { $0.loadMore() },
            button("Sync drafts") { $0.syncDrafts() },
            status,
        ])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Lets simctl drive a scenario: `xcrun simctl launch <device> <bundle id> -scenario <name>`.
        if !ranScenario, let scenario = UserDefaults.standard.string(forKey: "scenario") {
            ranScenario = true
            runScenario(scenario)
        }
    }

    private func openProfile() {
        Telemetry.track("open_profile")
        do {
            let profile = try ProfileParser().parse(FakeBackend.profileJSON)
            status.text = "Profile: \(profile.displayName)"
        } catch {
            status.text = "The profile failed to load"
        }
    }

    private func loadMore() {
        guard nextPage < feedPager.pageCount else {
            status.text = "End of the feed"
            return
        }
        Telemetry.track("load_more")
        Telemetry.setValue(nextPage, forKey: "feed_page")
        let items = feedPager.page(nextPage)
        nextPage += 1
        status.text = "Page \(nextPage): \(items.count) posts"
    }

    private func syncDrafts() {
        Telemetry.track("sync_drafts")
        sync.start { [weak self] sent in
            self?.status.text = "Synced \(sent) drafts"
        }
    }

    private func runScenario(_ name: String) {
        switch name {
        case "parser":
            openProfile()
        case "paging":
            for _ in 0..<feedPager.pageCount { loadMore() }
        case "lifecycle":
            // The crash comes once the user leaves the app and its background time runs out.
            syncDrafts()
        default:
            status.text = "Unknown scenario: \(name)"
        }
    }

    private func button(_ title: String, action: @escaping (MainViewController) -> Void) -> UIButton {
        UIButton(configuration: .filled(), primaryAction: UIAction(title: title) { [weak self] _ in
            if let self { action(self) }
        })
    }
}
