import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANGELOG, MANIFEST, cutChangelog, main, nextVersion, setVersion } from '../scripts/release.ts';
import { initRepo, sh, tempDir } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const manifest = (version: string) => `{
  "name": "fixcrash",
  "version": "${version}",
  "keywords": ["crashlytics", "firebase"],
  "userConfig": {
    "max_hypotheses": { "type": "number", "default": 3 }
  }
}
`;

const changelog = `# Changelog

Intro.

## Unreleased

- A fix.

### Added

- A command.

## 0.1.0 (2026-10-20)

The first release.
`;

test('the next version follows the latest release tag, compared as numbers', () => {
  assert.equal(nextVersion([], 'patch'), '0.0.1');
  assert.equal(nextVersion([''], 'minor'), '0.1.0');
  assert.equal(nextVersion([], 'major'), '1.0.0');
  const tags = ['v0.9.3', 'v0.10.0', 'v0.2.7', 'fixcrash--v9.0.0', 'v1.0.0-rc.1', 'latest', ''];
  assert.equal(nextVersion(tags, 'patch'), '0.10.1');
  assert.equal(nextVersion(tags, 'minor'), '0.11.0');
  assert.equal(nextVersion(tags, 'major'), '1.0.0');
});

test('the manifest gets the version and keeps its formatting', () => {
  assert.equal(setVersion(manifest('0.1.0'), '0.2.0'), manifest('0.2.0'));
  assert.equal(setVersion(manifest('0.1.0'), '0.1.0'), manifest('0.1.0'));
  assert.throws(() => setVersion(manifest('0.2.0'), '0.1.1'), /at 0\.2\.0, ahead of 0\.1\.1/);
  assert.throws(() => setVersion(manifest('next'), '0.1.0'), /no version of the form/);
});

test('the Unreleased section moves under the version, and is the notes', () => {
  const cut = cutChangelog(changelog, '0.2.0', '2026-11-02');
  assert.equal(cut.notes, '- A fix.\n\n### Added\n\n- A command.\n');
  assert.equal(cut.changelog, `# Changelog

Intro.

## Unreleased

## 0.2.0 (2026-11-02)

- A fix.

### Added

- A command.

## 0.1.0 (2026-10-20)

The first release.
`);
  const first = cutChangelog('# Changelog\n\n## Unreleased\n\nThe first release.\n', '0.1.0', '2026-10-20');
  assert.equal(first.changelog, '# Changelog\n\n## Unreleased\n\n## 0.1.0 (2026-10-20)\n\nThe first release.\n');
  assert.equal(first.notes, 'The first release.\n');
});

test('a release needs an Unreleased section with something in it', () => {
  assert.throws(() => cutChangelog(cutChangelog(changelog, '0.2.0', '2026-11-02').changelog, '0.3.0', '2026-11-03'), /nothing under/);
  assert.throws(() => cutChangelog('# Changelog\n\n## 0.1.0\n\nText.\n', '0.2.0', '2026-11-02'), /no "## Unreleased" section/);
});

test('main writes the manifest, the changelog and the notes, and prints the version', (t) => {
  const dir = tempDir(t);
  initRepo(dir, { [MANIFEST]: manifest('0.1.0'), [CHANGELOG]: changelog });
  sh(dir, 'git', 'tag', 'v0.1.0');
  const log = t.mock.method(console, 'log', () => {});
  const notes = join(dir, 'notes.md');
  assert.equal(main(['minor', notes], dir, new Date('2026-11-02T10:00:00Z')), 0);
  assert.deepEqual(log.mock.calls.map((c) => c.arguments), [['0.2.0']]);
  assert.equal(readFileSync(join(dir, MANIFEST), 'utf8'), manifest('0.2.0'));
  assert.match(readFileSync(join(dir, CHANGELOG), 'utf8'), /## Unreleased\n\n## 0\.2\.0 \(2026-11-02\)\n\n- A fix\./);
  assert.equal(readFileSync(notes, 'utf8'), '- A fix.\n\n### Added\n\n- A command.\n');
});

test('main changes nothing when it refuses', (t) => {
  const dir = tempDir(t);
  const empty = '# Changelog\n\n## Unreleased\n\n## 0.1.0 (2026-10-20)\n\nThe first release.\n';
  initRepo(dir, { [MANIFEST]: manifest('0.1.0'), [CHANGELOG]: empty });
  sh(dir, 'git', 'tag', 'v0.1.0');
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(main(['patch', join(dir, 'notes.md')], dir), 1);
  assert.match(String(error.mock.calls[0]?.arguments[0]), /nothing under "## Unreleased"/);
  assert.equal(sh(dir, 'git', 'status', '--porcelain'), '');
  assert.equal(main(['minor'], dir), 2);
  assert.equal(main(['next', 'notes.md'], dir), 2);
});

test("the repository's manifest and changelog have what a release reads", () => {
  const text = readFileSync(join(ROOT, MANIFEST), 'utf8');
  const { version } = JSON.parse(text) as { version: string };
  assert.equal(setVersion(text, version), text);
  assert.match(readFileSync(join(ROOT, CHANGELOG), 'utf8'), /\n## Unreleased\n/);
});
