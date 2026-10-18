# Security

## Report a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Please don't open a public issue for it.

Say what an attacker controls (crash data, a repository, a test), what they get, and how to reproduce it. You'll get an answer within a week.

## What counts

fixcrash reads crash data that anyone who can crash an app can shape, and it runs the app's build and tests. Reports about these are the most useful:

- **Proof bypass:** a pull request opened without a receipt for its commit, or a receipt for a fix that `fixcrash verify` didn't check.
- **Redaction misses:** personal data from a crash event that reaches Claude, a test, a commit, a pull request or a Crashlytics note.
- **Crash data as input:** an exception message, log, custom key or breadcrumb that makes fixcrash run a command, write a file or reach a host it shouldn't.
- **Writes outside the rules:** a write to Crashlytics other than a note, or a change to an issue's state.
- **The plugin's own files:** paths built from issue or session ids that leave fixcrash's state directory.

Known limits are listed in [docs/PLAN.md](docs/PLAN.md), under Deferred. For example, the hook recognizes state writes and pull request commands by their text, so it guards against a careless agent, not a hostile one. A new way past a listed limit is still worth a report.

## Supported versions

The latest release. Fixes ship in a new version, listed in [CHANGELOG.md](CHANGELOG.md).

## What fixcrash runs and sends

Everything it runs, sends, fetches and writes is listed in [plugin/README.md](plugin/README.md#what-fixcrash-runs-sends-and-writes).
