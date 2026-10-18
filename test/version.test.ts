import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitForVersion, tagCandidates, VersionError } from '../plugin/src/version.ts';
import { commit, initRepo, sh, tempDir } from './helpers.ts';

function repoWithTags(t: Parameters<typeof tempDir>[0]) {
  const dir = tempDir(t);
  const first = initRepo(dir, { 'a.txt': '1\n' });
  sh(dir, 'git', 'tag', 'v1.0');
  const second = commit(dir, { 'a.txt': '2\n' }, 'second');
  sh(dir, 'git', 'tag', '-a', '-m', 'release', 'release/1.1-11');
  return { dir, first, second };
}

test('finds the commit by the build stamp revision', (t) => {
  const { dir, first } = repoWithTags(t);

  assert.deepEqual(commitForVersion(dir, '1.0', '1', { revision: first }), { commit: first, source: 'build stamp' });
  assert.deepEqual(commitForVersion(dir, '1.0', '1', { revision: first.slice(0, 10) }), { commit: first, source: 'build stamp' });
});

test('asks to fetch a build stamp revision that is not in the repository', (t) => {
  const { dir } = repoWithTags(t);

  assert.throws(() => commitForVersion(dir, '1.0', '1', { revision: 'f'.repeat(40) }), (e) => e instanceof VersionError && /git fetch origin f{40}/.test(e.message));
  assert.throws(() => commitForVersion(dir, '1.0', '1', { revision: 'HEAD' }), /not a commit sha/);
});

test('falls back to release tags, lightweight or annotated', (t) => {
  const { dir, first, second } = repoWithTags(t);

  assert.deepEqual(commitForVersion(dir, '1.0', '1'), { commit: first, source: 'tag v1.0' });
  assert.deepEqual(
    commitForVersion(dir, '1.1', '11', { tagPatterns: ['v{display}', 'release/{display}-{build}'] }),
    { commit: second, source: 'tag release/1.1-11' },
  );
});

test('names the tags it tried when none exists', (t) => {
  const { dir } = repoWithTags(t);

  assert.throws(() => commitForVersion(dir, '2.0', '20'), /none of these tags exist: v2.0, 2.0/);
});

test('fills tag patterns and drops duplicates', () => {
  assert.deepEqual(tagCandidates(['v{display}', 'v{display}', '{display}+{build}'], '1.2', '7'), ['v1.2', '1.2+7']);
});
