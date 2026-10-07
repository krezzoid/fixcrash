import assert from 'node:assert/strict';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReceipt, receiptPath } from '../src/receipt.ts';
import { gradle, type Runner } from '../src/runner.ts';
import { verify, VerifyError, type VerifyOptions } from '../src/verify.ts';
import { commit, initRepo, sh, tempDir } from './helpers.ts';

// Gradle's file layout and reports, with fake-runner.mjs in place of ./gradlew.
const fake: Runner = {
  ...gradle,
  name: 'fake',
  targetCommand: (testId) => [process.execPath, 'fake-runner.mjs', 'target', testId],
  suiteCommand: () => [process.execPath, 'fake-runner.mjs', 'suite'],
  environment: () => undefined,
};

const PARSER = 'app/src/main/java/com/example/Parser.kt';
const TESTS = 'app/src/test/java/com/example';
const TEST_ID = 'com.example.ParserTest.parsesWithoutAvatar';
const EXPECTED = { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' };

/** A project at the crashing version: Parser has the bug, an existing test passes. */
function crashingProject(t: Parameters<typeof tempDir>[0]): { dir: string; base: string } {
  const dir = tempDir(t);
  copyFileSync(new URL('./fixtures/fake-runner.mjs', import.meta.url), join(dir, 'fake-runner.mjs'));
  const base = initRepo(dir, {
    '.gitignore': 'build/\nlocal.properties\n',
    [PARSER]: 'behaviour: bug\n',
    [`${TESTS}/ExistingTest.kt`]: 'test parsesFullProfile pass\n',
  });
  writeFileSync(join(dir, 'local.properties'), 'sdk.dir=/nowhere\n');
  sh(dir, 'git', 'switch', '--quiet', '-c', 'fix');
  return { dir, base };
}

function run(dir: string, base: string, extra: Partial<VerifyOptions> = {}) {
  const lines: string[] = [];
  const result = verify({
    cwd: dir, issue: 'issue-1', test: TEST_ID, expected: EXPECTED, base, runner: fake,
    log: (l) => lines.push(l), ...extra,
  });
  return { ...result, output: lines.join('\n') };
}

const gitDir = (dir: string) => join(dir, '.git');

test('verifies a fix: fails at base as the crash did, passes with the fix, suite green', (t) => {
  const { dir, base } = crashingProject(t);
  const head = commit(dir, {
    [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n',
    [PARSER]: 'behaviour: fixed\n',
  }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, true, r.output);
  assert.deepEqual(r.runs.map((x) => [x.role, x.ok]), [['base', true], ['head', true]]);
  assert.equal(r.runs[0]!.target[0]!.frame, 'com.example.Parser.parse(Parser.kt:3)');
  assert.equal(r.runs[1]!.tests.total, 2);
  assert.match(r.output, /same commit as base/);
  const check = checkReceipt(gitDir(dir), head);
  assert.equal(check.ok, true);
  assert.ok(check.ok && check.receipt.issue === 'issue-1' && check.receipt.base === base);
  assert.deepEqual(check.ok && check.receipt.fixFiles, [PARSER]);
  // The user's checkout is untouched: no reports, no overlay.
  assert.equal(existsSync(join(dir, 'app/build')), false);
});

test('runs the test at the fix parent too, when it differs from base', (t) => {
  const { dir, base } = crashingProject(t);
  sh(dir, 'git', 'switch', '--quiet', 'master');
  const from = commit(dir, { 'README.md': 'later\n' }, 'unrelated change');
  sh(dir, 'git', 'switch', '--quiet', '-C', 'fix');
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, true, r.output);
  assert.deepEqual(r.runs.map((x) => [x.role, x.commit]), [['base', base], ['from', from], ['head', r.receipt!.head]]);
});

test('rejects a test that passes on the crashing version', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar pass\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /passed at \w+: it must fail there/);
});

test('rejects a failure with another exception type', (t) => {
  const { dir, base } = crashingProject(t);
  sh(dir, 'git', 'switch', '--quiet', 'master');
  const wrong = commit(dir, { [PARSER]: 'behaviour: wrong\n' }, 'crashes differently');
  sh(dir, 'git', 'switch', '--quiet', '-C', 'fix');
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  const r = run(dir, wrong);

  assert.equal(r.verified, false);
  assert.match(r.reason, /not as the crash did: failed with java.lang.IllegalStateException, not java.lang.NullPointerException/);
});

test('rejects a failure that does not pass through the crash frame', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  const r = run(dir, base, { expected: { ...EXPECTED, frame: 'com.example.Feed.page' } });

  assert.equal(r.verified, false);
  assert.match(r.reason, /does not pass through com.example.Feed.page/);
});

test('rejects an exception thrown from test code, such as a stub', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, {
    [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar stub\n',
    [`${TESTS}/FakeSource.kt`]: 'class FakeSource\n',
    [PARSER]: 'behaviour: fixed\n',
  }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /thrown from test code at com.example.FakeSource.read\(FakeSource.kt:4\)/);
});

test('rejects a test that does not compile on the crashing version', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, {
    [`${TESTS}/ParserTest.kt`]: 'needs avatarOrNull\ntest parsesWithoutAvatar crash\n',
    [PARSER]: 'behaviour: fixed\napi: avatarOrNull\n',
  }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /did not run at \w+ \(the command exited with 1; does it compile there\?\)/);
  assert.match(r.output, /unresolved reference 'avatarOrNull'/);
});

test('rejects a fix after which the test still fails', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', 'README.md': 'not a fix\n' }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /parsesWithoutAvatar failed with the fix: java.lang.NullPointerException/);
});

test('rejects a fix when another test fails', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, {
    [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n',
    [`${TESTS}/ExistingTest.kt`]: 'test parsesFullProfile fail\n',
    [PARSER]: 'behaviour: fixed\n',
  }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /suite is red with the fix: 1 failed \(com.example.ExistingTest.parsesFullProfile\)/);
});

test('says the crash may already be fixed when the test passes at the fix parent', (t) => {
  const { dir, base } = crashingProject(t);
  sh(dir, 'git', 'switch', '--quiet', 'master');
  commit(dir, { [PARSER]: 'behaviour: fixed\n' }, 'fixed by someone else');
  sh(dir, 'git', 'switch', '--quiet', '-C', 'fix');
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', 'README.md': 'x\n' }, 'test');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.match(r.reason, /may already be fixed/);
});

test('a failed verify removes an earlier receipt for the same commit', (t) => {
  const { dir, base } = crashingProject(t);
  const head = commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');
  assert.equal(run(dir, base).verified, true);

  const r = run(dir, base, { expected: { ...EXPECTED, exception: 'java.lang.IllegalStateException' } });

  assert.equal(r.verified, false);
  assert.equal(existsSync(receiptPath(gitDir(dir), head)), false);
});

test('refuses uncommitted changes', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n' }, 'test');
  writeFileSync(join(dir, PARSER), 'behaviour: fixed\n');

  assert.throws(() => run(dir, base), (e) => e instanceof VerifyError && /uncommitted changes/.test(e.message));
});

test('refuses a branch with no fix, or a test the fix did not touch', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n' }, 'test only');
  assert.throws(() => run(dir, base), /only test files changed/);

  commit(dir, { [PARSER]: 'behaviour: fixed\n' }, 'fix');
  assert.throws(() => run(dir, base, { test: 'com.example.ExistingTest.parsesFullProfile' }), /must be new or changed/);
});

test('refuses HEAD on the default branch without --from', (t) => {
  const { dir, base } = crashingProject(t);
  sh(dir, 'git', 'switch', '--quiet', 'master');
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  assert.throws(() => run(dir, base), /commit the test and the fix on a branch, or pass --from/);
  assert.equal(run(dir, base, { from: 'HEAD~1' }).verified, true);
});
