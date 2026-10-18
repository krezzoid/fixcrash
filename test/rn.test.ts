// symbolicate, reproduce and verify on a React Native app, end to end, with
// fixtures/fake-rn.mjs in place of npm, Jest, Metro, hermesc and
// metro-symbolicate. Values are synthetic.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJsError, type CrashEvent } from '../plugin/src/event.ts';
import { checkReceipt } from '../plugin/src/receipt.ts';
import { recordEvent } from '../plugin/src/record.ts';
import { reproduce } from '../plugin/src/reproduce.ts';
import { symbolicateIssue } from '../plugin/src/symbolicate.ts';
import { verify } from '../plugin/src/verify.ts';
import { commit, initRepo, sh, tempDir, writeFiles } from './helpers.ts';

type T = Parameters<typeof tempDir>[0];

const FAKE_RN = fileURLToPath(new URL('./fixtures/fake-rn.mjs', import.meta.url));
const ISSUE = '0000rn09';
const TEST = '__tests__/profile.test.ts::Profile parses without an avatar';

// The crash's line: where the fake Jest throws, and where the bundle's map places column 485277.
const CRASH = '  return raw.avatar.url; // behaviour: bug, bundle column 485277 in parseProfile';
const profile = (header = '') => `${header}export function parseProfile(raw) {\n${CRASH}\n}\n`;
const FIXED = profile('// Profiles come from the backend.\n').replace(CRASH, '  return raw.avatar?.url; // behaviour: fixed');

function withEnv(t: T, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    const saved = process.env[name];
    process.env[name] = value;
    t.after(() => (saved === undefined ? delete process.env[name] : (process.env[name] = saved)));
  }
}

/** Android's fatal JS error, as the hook reads it. */
const jsEvent = (): CrashEvent => ({
  name: `projects/1/apps/1:1:android:rn/events/${ISSUE}_1`,
  issueId: ISSUE,
  issueTitle: 'com.facebook.react.modules.core.ExceptionsManagerModule.reportException',
  errorType: 'FATAL',
  platform: 'ANDROID',
  version: { display: '1.0', build: '1' },
  exceptions: [],
  jsError: parseJsError("com.facebook.react.common.JavascriptException: TypeError: Cannot read property 'url' of undefined, stack:\nparseProfile@1:485277\nanonymous@1:708373")!,
});

/**
 * The app at its released version (`base`, the crash at src/profile.ts:2), then
 * a later commit on master that adds a line above it. The event is recorded.
 */
function fakeApp(t: T) {
  const root = tempDir(t);
  const dir = join(root, 'app');
  mkdirSync(dir);
  writeFiles(root, { 'bin/npm': `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_RN)} npm "$@"\n` });
  chmodSync(join(root, 'bin/npm'), 0o755);
  const calls = join(root, 'calls');
  const cache = join(root, 'cache');
  withEnv(t, { PATH: `${join(root, 'bin')}:${process.env.PATH}`, XDG_CACHE_HOME: cache, FAKE_RN_CALLS: calls });
  const base = initRepo(dir, {
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify({ name: 'app', devDependencies: { jest: '^29.6.3' } }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'index.js': "import './src/profile';\n",
    'src/profile.ts': profile(),
    '__tests__/existing.test.ts': 'test: Profile parses a full profile => pass\n',
  });
  const later = commit(dir, { 'src/profile.ts': profile('// Profiles come from the backend.\n') }, 'later');
  recordEvent(join(dir, '.git'), jsEvent());
  return {
    dir, base, later, cache,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
  };
}

test("places a recorded JS error in the crashing commit's sources, and builds that bundle once", (t) => {
  const app = fakeApp(t);

  const r = symbolicateIssue({ cwd: app.dir, issue: ISSUE, base: app.base });

  assert.equal(r.expected.frame, 'src/profile.ts:2');
  assert.deepEqual(r.expected.js!.source, { file: 'src/profile.ts', line: 2, fn: 'parseProfile' });
  assert.deepEqual(r.chain, ['parseProfile (src/profile.ts:2)', 'anonymous@1:708373 (not in the map)']);
  assert.equal(r.note, "version 1.0 (1)'s android bundle places the crash in parseProfile at src/profile.ts:2");
  symbolicateIssue({ cwd: app.dir, issue: ISSUE, base: app.base });
  assert.deepEqual(app.calls(), ['npm', 'bundle', 'hermesc', 'compose', 'symbolicate', 'symbolicate']);
  // Jest and Metro skip every path with .git in it (ADR-0005).
  assert.equal(existsSync(join(app.dir, '.git/fixcrash/worktree')), false);
  assert.ok(existsSync(join(app.cache, 'fixcrash/worktrees')));
});

test('installs node_modules again for a cached bundle when the worktree was deleted', (t) => {
  const app = fakeApp(t);
  symbolicateIssue({ cwd: app.dir, issue: ISSUE, base: app.base });
  // The user cleans their cache directory; the bundle stays cached in .git/fixcrash.
  rmSync(join(app.cache, 'fixcrash/worktrees'), { recursive: true });

  const r = symbolicateIssue({ cwd: app.dir, issue: ISSUE, base: app.base });

  assert.equal(r.expected.frame, 'src/profile.ts:2');
  assert.deepEqual(app.calls(), ['npm', 'bundle', 'hermesc', 'compose', 'symbolicate', 'npm', 'symbolicate']);
});

test('reproduces a JS error with an uncommitted Jest test, run alone at the crashing version', (t) => {
  const app = fakeApp(t);
  writeFiles(app.dir, {
    '__tests__/profile.test.ts': 'test: Profile parses without an avatar => crash\ntest: Profile parses without a name => pass\n',
  });
  const lines: string[] = [];

  const r = reproduce({
    cwd: app.dir, issue: ISSUE, test: TEST, base: app.base, hypothesis: 'the avatar is missing', maxAttempts: 3, maxHypotheses: 2,
    run: 'r1', log: (l) => lines.push(l),
  });

  const output = lines.join('\n');
  assert.equal(r.status, 'reproduced', output);
  assert.equal(r.record!.tests.total, 1);
  assert.match(output, /crash site: version 1\.0 \(1\)'s android bundle places the crash in parseProfile at src\/profile\.ts:2/);
  assert.match(output, /REPRODUCED at \w+: fails as the crash did: TypeError at src\/profile\.ts:2/);
});

test('a JS test that fails on its own assertion does not reproduce the crash', (t) => {
  const app = fakeApp(t);
  writeFiles(app.dir, { '__tests__/profile.test.ts': 'test: Profile parses without an avatar => fail\n' });

  const r = reproduce({
    cwd: app.dir, issue: ISSUE, test: TEST, base: app.base, hypothesis: 'the avatar is missing', maxAttempts: 3, maxHypotheses: 2,
  });

  assert.equal(r.status, 'not-reproduced');
  assert.match(r.reason, /fails at \w+, but not as the crash did: failed with Error, not TypeError/);
});

test("verifies a JS fix whose parent has the crash's line elsewhere", (t) => {
  const app = fakeApp(t);
  sh(app.dir, 'git', 'switch', '--quiet', '-c', 'fix');
  const head = commit(app.dir, {
    '__tests__/profile.test.ts': 'test: Profile parses without an avatar => crash\n',
    'src/profile.ts': FIXED,
  }, 'fix');
  const lines: string[] = [];

  const r = verify({ cwd: app.dir, issue: ISSUE, test: TEST, base: app.base, log: (l) => lines.push(l) });

  const output = lines.join('\n');
  assert.equal(r.verified, true, output);
  assert.deepEqual(r.runs.map((x) => [x.role, x.commit, x.ok]), [['base', app.base, true], ['from', app.later, true], ['head', head, true]]);
  assert.match(output, /from \w+: the crash's line src\/profile\.ts:2 is line 3 here/);
  assert.equal(r.runs[1]!.target[0]!.frame, 'src/profile.ts:3');
  assert.equal(r.runs[2]!.tests.total, 2);
  const check = checkReceipt(join(app.dir, '.git'), head);
  assert.ok(check.ok);
  assert.equal(check.receipt.runner, 'jest');
  assert.equal(check.receipt.expected.frame, 'src/profile.ts:2');
  // node_modules: installed once, for the one lockfile.
  assert.equal(app.calls().filter((c) => c === 'npm').length, 1);
});

test("says how to fill npm's cache when node_modules can't be installed offline", (t) => {
  const app = fakeApp(t);
  withEnv(t, { FAKE_NPM_ENOTCACHED: '1' });

  assert.throws(
    () => symbolicateIssue({ cwd: app.dir, issue: ISSUE, base: app.base }),
    /cannot build the android bundle of \w+ .*Run `npm ci` once in your checkout, which fills the cache/,
  );
});
