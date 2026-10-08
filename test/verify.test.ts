import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReceipt, receiptPath } from '../src/receipt.ts';
import { recordEvent } from '../src/record.ts';
import { verify, VerifyError, type VerifyOptions } from '../src/verify.ts';
import {
  commit, crashingProject, EXPECTED, fakeRunner as fake, PARSER, parserEvent, sh, TEST_ID, TESTS,
} from './helpers.ts';

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

test('rejects a test that reaches the crash by a shortcut, before running anything', (t) => {
  const { dir, base } = crashingProject(t);
  const head = commit(dir, {
    [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\nParser::class.java.getDeclaredMethod("parse").isAccessible = true\n',
    [PARSER]: 'behaviour: fixed\n',
  }, 'fix');

  const r = run(dir, base);

  assert.equal(r.verified, false);
  assert.deepEqual(r.runs, []);
  assert.match(r.output, /NOT VERIFIED: the test reaches the crash from a state the app is never in \(.*ParserTest\.kt: opens a private member through reflection, line 2\)/);
  assert.equal(existsSync(receiptPath(gitDir(dir), head)), false);
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

  assert.throws(() => run(dir, base), (e) => e instanceof VerifyError && /uncommitted changes \(app\/src\/main\/java\/com\/example\/Parser.kt\)/.test(e.message));
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

test('takes the expected failure from the recorded Crashlytics event', (t) => {
  const { dir, base } = crashingProject(t);
  recordEvent(gitDir(dir), parserEvent());
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');

  const r = run(dir, base, { expected: undefined });

  assert.equal(r.verified, true, r.output);
  assert.equal(r.receipt!.expectedSource, 'event');
  assert.match(r.output, /from the recorded Crashlytics event/);
  assert.equal(run(dir, base).receipt!.expectedSource, 'event', 'arguments that match the record count as the event');
});

test('refuses arguments that contradict the recorded event, and runs without either', (t) => {
  const { dir, base } = crashingProject(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' }, 'fix');
  assert.throws(() => run(dir, base, { expected: undefined }), /no recorded event for issue issue-1/);
  assert.equal(run(dir, base).receipt!.expectedSource, 'arguments');

  recordEvent(gitDir(dir), parserEvent());
  assert.throws(
    () => run(dir, base, { expected: { ...EXPECTED, exception: 'java.lang.IllegalStateException' } }),
    (e) => e instanceof VerifyError && /recorded events expect java.lang.NullPointerException at com.example.Parser.parse/.test(e.message),
  );
});
