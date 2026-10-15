import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prBody } from '../src/prbody.ts';
import type { Receipt, RunRecord } from '../src/receipt.ts';

const sha = (c: string) => c.repeat(40);

function run(role: RunRecord['role'], commit: string, ok: Partial<RunRecord> = {}): RunRecord {
  return {
    role, commit, command: [], exitCode: role === 'head' ? 0 : 1, durationMs: 1, log: 'fixcrash/logs/x.log',
    tests: { total: 4, failed: 0, skipped: 1 }, ok: true, reason: '',
    target: role === 'head'
      ? [{ name: 'com.example.ParserTest.parsesWithoutAvatar', status: 'passed' }]
      : [{
        name: 'com.example.ParserTest.parsesWithoutAvatar', status: 'failed', exception: 'java.lang.NullPointerException',
        message: 'synthetic message', frame: 'com.example.Parser.parse(Parser.kt:12)',
      }],
    ...ok,
  };
}

const receipt: Receipt = {
  schema: 2, verified: true, head: sha('c'), base: sha('a'), from: sha('b'), issue: '0000c0de',
  test: 'com.example.ParserTest.parsesWithoutAvatar',
  expected: { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' }, expectedSource: 'event',
  projectDir: '', runner: 'gradle', testFiles: ['app/src/test/java/com/example/ParserTest.kt'], fixFiles: ['app/src/main/java/com/example/Parser.kt'],
  runs: [run('base', sha('a')), run('from', sha('b')), run('head', sha('c'))], createdAt: '', fixcrash: '0.1.0',
};

test('describes the proof: each commit, what the test did there, and where the expectation came from', () => {
  const body = prBody(receipt);

  assert.match(body, /^Fixes Crashlytics issue `0000c0de`: `java.lang.NullPointerException` at `com.example.Parser.parse`\./);
  assert.match(body, /\| Crashing version \| `aaaaaaaaaaaa` \| `ParserTest.parsesWithoutAvatar` fails as the crash did: `java.lang.NullPointerException` at `Parser.parse\(Parser.kt:12\)` \|/);
  assert.match(body, /\| Where the fix starts \| `bbbbbbbbbbbb` \| `ParserTest/);
  assert.match(body, /\| This branch \| `cccccccccccc` \| `ParserTest.parsesWithoutAvatar` passes; full suite green: 4 tests, 1 skipped \|/);
  assert.match(body, /- Test: `app\/src\/test\/java\/com\/example\/ParserTest.kt`/);
  assert.match(body, /from the Crashlytics event, as recorded by the fixcrash hook/);
  assert.match(body, /receipt for `c{40}`/);
  assert.doesNotMatch(body, /synthetic message|fixcrash\/logs/, 'no messages, no local paths');
});

test('says when the fix starts at the crashing version', () => {
  const body = prBody({ ...receipt, from: sha('a'), runs: [run('base', sha('a')), run('head', sha('c'))] });

  assert.match(body, /\| Where the fix starts \| `aaaaaaaaaaaa` \| same commit as the crashing version \|/);
});

test('says what the release build showed at an iOS crash site', () => {
  const ios: Receipt = {
    ...receipt,
    expected: { exception: 'EXC_BREAKPOINT', frame: 'ProfileParser.parse(_:)' },
    crashSite: { note: 'the crash is in ProfileParser.parse(_:)(ProfileParser.swift:10), inlined into ProfileViewController.showProfile()' },
  };

  assert.match(prBody(ios), /^- Crash site, from a release build of the crashing version: the crash is in ProfileParser\.parse\(_:\)\(ProfileParser\.swift:10\), inlined into ProfileViewController\.showProfile\(\)\.$/m);
  assert.doesNotMatch(prBody(receipt), /Crash site/);
});
