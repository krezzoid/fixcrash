// React Native JS errors (ADR-0004, ADR-0005): events, the Jest runner's
// pieces, the match, and the worktree. Values are synthetic.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expectationOf, parseEvents, parseJsError, toCrashEvent } from '../plugin/src/event.ts';
import { movedLine } from '../plugin/src/git.ts';
import { isJestProject, jest, parseJestJson, parseSymbolicated, parseV8Stack, splitTestId } from '../plugin/src/jest.ts';
import { selectCases } from '../plugin/src/junit.ts';
import { readRecord, recordEvent, resolveExpectation } from '../plugin/src/record.ts';
import { checkRunnerFits, jsExpectedAt, worktreePath, type Project } from '../plugin/src/run.ts';
import { gradle } from '../plugin/src/runner.ts';
import { matchJsFailure, type Expected, type Frame } from '../plugin/src/stack.ts';
import { commit, initRepo, sh, tempDir, writeFiles } from './helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/crashlytics/${name}`, import.meta.url), 'utf8');
const rnEvents = () => parseEvents(fixture('events-rn.yaml')).map((f) => toCrashEvent(f)!);

// --- Events ------------------------------------------------------------------

test("reads a fatal JS error from React Native's native crash: the type, and the stack after `, stack:`", () => {
  const error = parseJsError([
    'com.facebook.react.common.JavascriptException: TypeError: Cannot read property \'url\' of undefined, stack:',
    'parseProfile@1:485277',
    'anonymous@1:708373',
    '',
    'at com.facebook.react.modules.core.ExceptionsManagerModule.reportException (ExceptionsManagerModule.kt:52)',
  ].join('\n'));
  assert.deepEqual(error, {
    type: 'TypeError',
    kind: 'JavascriptException',
    frames: [{ fn: 'parseProfile', line: 1, column: 485277 }, { fn: 'anonymous', line: 1, column: 708373 }],
  });
});

test("skips a render error's component stack, and a message without a type", () => {
  const [render] = rnEvents();
  assert.deepEqual(render!.jsError!.frames.map((f) => `${f.fn}@${f.column}`), ['anonymous@665004', 'TagList@487346', 'renderWithHooks@267352']);
  const untyped = parseJsError('RCTFatalException: Unhandled JS Exception: something went wrong, stack:\nrun@1:10');
  assert.deepEqual(untyped, { kind: 'RCTFatalException', frames: [{ fn: 'run', line: 1, column: 10 }] });
});

test("reads React Native Firebase's non-fatals: frames in the bundle only, iOS's extra line dropped", () => {
  const [, android, , ios] = rnEvents();
  assert.deepEqual(android!.jsError, {
    kind: 'JavaScriptError',
    frames: [{ fn: '?anon_0_', line: 1, column: 698961 }, { fn: 'asyncGeneratorStep', line: 1, column: 432790 }],
  });
  assert.deepEqual(ios!.jsError!.frames, [{ fn: 'parseProfile', line: 1, column: 484854 }, { fn: 'anonymous', line: 1, column: 706303 }]);
  assert.equal(parseJsError('java.lang.NullPointerException: x\nat com.example.Parser.parse (Parser.kt:3)'), undefined);
});

test('expects a JS error by its type when the event names it, and by its first frame in the bundle', () => {
  const [render, async, iosFatal, iosNonFatal] = rnEvents().map((e) => expectationOf(e)!);
  assert.equal(render!.exception, 'TypeError');
  assert.equal(render!.frame, 'anonymous@1:665004');
  assert.deepEqual(render!.js!.version, { display: '1.0', build: '1' });
  assert.equal(render!.js!.platform, 'android');
  assert.equal(render!.js!.typed, true);
  assert.equal(async!.exception, 'JavaScriptError');
  assert.equal(async!.js!.typed, false);
  assert.equal(iosFatal!.exception, 'TypeError');
  assert.equal(iosFatal!.frame, 'parseProfile@1:484854');
  assert.equal(iosFatal!.js!.platform, 'ios');
  assert.equal(iosNonFatal!.js!.typed, false);
});

test('records each JS error of one issue on its own, and hands back its positions', (t) => {
  const gitDir = tempDir(t);
  const [render] = rnEvents();
  const parser = { ...render!, name: 'projects/1/apps/1:1:android:rn/events/RN0001_2', jsError: parseJsError('com.facebook.react.common.JavascriptException: TypeError: x, stack:\nparseProfile@1:485277')! };
  recordEvent(gitDir, render!);
  recordEvent(gitDir, parser);
  recordEvent(gitDir, render!);

  assert.deepEqual(readRecord(gitDir, '0000rn01')!.expectations.map((e) => e.frame), ['anonymous@1:665004', 'parseProfile@1:485277']);
  assert.throws(() => resolveExpectation(gitDir, '0000rn01'), /several recorded failures \(TypeError at anonymous@1:665004; TypeError at parseProfile@1:485277\)/);
  const picked = resolveExpectation(gitDir, '0000rn01', { exception: 'TypeError', frame: 'parseProfile@1:485277' });
  assert.equal(picked.source, 'event');
  assert.deepEqual(picked.expected.js!.frames, [{ fn: 'parseProfile', line: 1, column: 485277 }]);
});

// --- Jest ----------------------------------------------------------------------

const ROOT = '/work/app';
const FAILURE = [
  "TypeError: Cannot read properties of undefined (reading 'url')",
  `    at url (${ROOT}/src/profile.ts:15:62)`,
  `    at Object.<anonymous> (${ROOT}/__tests__/profile.test.ts:4:15)`,
  '    at new Promise (<anonymous>)',
  `    at callAsyncCircusFn (${ROOT}/node_modules/jest-circus/build/utils.js:231:10)`,
].join('\n');

test("reads Jest's failure: the error's name, its message, frames relative to the project", () => {
  const [t] = parseV8Stack(FAILURE, ROOT);
  assert.equal(t!.type, 'TypeError');
  assert.equal(t!.message, "Cannot read properties of undefined (reading 'url')");
  assert.deepEqual(t!.frames, [
    { symbol: 'url', file: 'src/profile.ts', line: 15 },
    { symbol: 'Object.<anonymous>', file: '__tests__/profile.test.ts', line: 4 },
    { symbol: 'new Promise' },
    { symbol: 'callAsyncCircusFn', file: 'node_modules/jest-circus/build/utils.js', line: 231 },
  ]);
  const [assertion] = parseV8Stack(`Error: expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2\n    at Object.toBe (${ROOT}/__tests__/a.test.ts:3:9)`, ROOT);
  assert.equal(assertion!.type, 'Error');
  assert.match(assertion!.message, /Received: 2/);
});

test("reads Jest's --json results: cases by file and full name, and a test file that didn't load", () => {
  const json = JSON.stringify({
    testResults: [
      {
        name: `${ROOT}/__tests__/profile.test.ts`,
        status: 'failed',
        assertionResults: [
          { fullName: 'Profile parses without an avatar', status: 'failed', failureMessages: [FAILURE] },
          { fullName: 'Profile parses', status: 'passed', failureMessages: [] },
          { fullName: 'Profile later', status: 'pending', failureMessages: [] },
        ],
      },
      { name: `${ROOT}/__tests__/broken.test.ts`, status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] },
    ],
  });
  const cases = parseJestJson(json, ROOT);
  assert.deepEqual(cases.map((c) => [c.classname, c.name, c.status]), [
    ['__tests__/profile.test.ts', 'Profile parses without an avatar', 'failed'],
    ['__tests__/profile.test.ts', 'Profile parses', 'passed'],
    ['__tests__/profile.test.ts', 'Profile later', 'skipped'],
    ['__tests__/broken.test.ts', '(the test file failed to run)', 'failed'],
  ]);
  assert.equal(cases[0]!.failure!.type, 'TypeError');
  assert.deepEqual(selectCases(cases, '__tests__/profile.test.ts::Profile parses').map((c) => c.name), ['Profile parses']);
  assert.equal(selectCases(cases, '__tests__/profile.test.ts').length, 3);
  assert.equal(jest.caseName!(cases[0]!), '__tests__/profile.test.ts::Profile parses without an avatar');
});

test('names Jest tests by file and full name, and runs one with an anchored, escaped pattern', () => {
  assert.deepEqual(splitTestId('__tests__/a.test.ts::A (b) works'), { file: '__tests__/a.test.ts', name: 'A (b) works' });
  assert.deepEqual(splitTestId('__tests__/a.test.ts'), { file: '__tests__/a.test.ts' });
  assert.equal(jest.locateTest('__tests__/a.test.ts::A works', ['src/a.ts', '__tests__/a.test.ts']), '__tests__/a.test.ts');
  const steps = jest.targetSteps('__tests__/a.test.ts::A (b) works?', '__tests__/a.test.ts', { out: '/out', cache: '/cache' });
  const command = steps.at(-1)!.command;
  assert.deepEqual(command.slice(-4), ['--runTestsByPath', '__tests__/a.test.ts', '--testNamePattern', '^A \\(b\\) works\\?$']);
  assert.ok(command.includes('--outputFile=/out/jest.json'));
  assert.match(steps[0]!.command.join(' '), /rnbuild\.ts deps$/);
  for (const p of ['__tests__/a.ts', 'src/a.test.tsx', 'src/__tests__/b.js', 'x.spec.mjs']) assert.ok(jest.isTestFile(p), p);
  for (const p of ['src/a.ts', 'node_modules/x/__tests__/a.js', 'src/test-utils.ts']) assert.ok(!jest.isTestFile(p), p);
});

test('finds a Jest project by its package.json or config', (t) => {
  const dir = tempDir(t);
  assert.equal(isJestProject(dir), false);
  writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { test: 'mocha' } }) });
  assert.equal(isJestProject(dir), false);
  writeFiles(dir, { 'package.json': JSON.stringify({ devDependencies: { jest: '^29.6.3' } }) });
  assert.equal(isJestProject(dir), true);
  writeFiles(dir, { 'package.json': '{}', 'jest.config.js': 'module.exports = {};' });
  assert.equal(isJestProject(dir), true);
});

test("reads metro-symbolicate's output: files relative to the project, unmapped frames kept by name", () => {
  const frames = [{ fn: 'parseProfile', line: 1, column: 485277 }, { fn: 'anonymous', line: 1, column: 1 }, { fn: 'x', line: 1, column: 2 }];
  const out = `${ROOT}/src/profile.ts:15:parseProfile\nnull:null:null\n${ROOT}/node_modules/react/index.js:3:render\n`;
  assert.deepEqual(parseSymbolicated(out, frames, ROOT), [
    { fn: 'parseProfile', file: 'src/profile.ts', line: 15 },
    { fn: 'anonymous' },
    { fn: 'render', file: 'node_modules/react/index.js', line: 3 },
  ]);
});

// --- The match (ADR-0004) -------------------------------------------------------

const jsExpected = (typed: boolean): Expected => ({
  exception: typed ? 'TypeError' : 'JavaScriptError',
  frame: 'src/profile.ts:15',
  js: { platform: 'android', typed, frames: [], source: { file: 'src/profile.ts', line: 15, fn: 'parseProfile' } },
});
const isTest = (f: Frame) => f.file?.startsWith('__tests__/') ?? false;
const chainOf = (text: string) => parseV8Stack(text, ROOT);

test('a JS failure matches by type, file and line, whatever Jest calls the function', () => {
  const m = matchJsFailure(chainOf(FAILURE), jsExpected(true), isTest);
  assert.ok(m.ok);
  assert.equal(m.ok && m.frameIndex, 0);
  assert.equal(matchJsFailure(chainOf(FAILURE.replace('TypeError', 'RangeError')), jsExpected(true), isTest).ok, false);
  // A non-fatal names no type: any error at the line will do.
  assert.equal(matchJsFailure(chainOf(FAILURE.replace('TypeError', 'RangeError')), jsExpected(false), isTest).ok, true);
});

test('a JS failure elsewhere, thrown by test code, or lost to .resolves does not match', () => {
  const elsewhere = matchJsFailure(chainOf(FAILURE.replace('profile.ts:15', 'profile.ts:16')), jsExpected(true), isTest);
  assert.deepEqual(elsewhere, { ok: false, reason: 'TypeError does not pass through src/profile.ts:15' });
  const stub = `TypeError: x\n    at fake (${ROOT}/__tests__/fakes.ts:2:3)\n    at url (${ROOT}/src/profile.ts:15:62)`;
  const fromTest = matchJsFailure(chainOf(stub), jsExpected(true), isTest);
  assert.ok(!fromTest.ok && /thrown from test code at fake\(__tests__\/fakes\.ts:2\)/.test(fromTest.reason));
  const resolves = `Error: expect(received).resolves.toBe()\n\nReceived promise rejected instead of resolved\n    at Object.toBe (${ROOT}/__tests__/a.test.ts:4:3)`;
  const lost = matchJsFailure(chainOf(resolves), jsExpected(false), isTest);
  assert.ok(!lost.ok && /await the call itself/.test(lost.reason));
  assert.deepEqual(matchJsFailure(chainOf(FAILURE), { ...jsExpected(true), js: { platform: 'ios', typed: true, frames: [] } }, isTest), {
    ok: false, reason: 'the crash was not symbolicated',
  });
});

test("follows the crash's line to the fix's parent, or keeps only its file when the line changed", (t) => {
  const dir = tempDir(t);
  const base = initRepo(dir, { 'src/a.ts': 'a\nb\nc\nd\n' });
  const moved = commit(dir, { 'src/a.ts': 'x\ny\na\nc\nd\n' }, 'two lines above, one removed');
  const changed = commit(dir, { 'src/a.ts': 'x\ny\na\nC\nd\n' }, 'the line changed');
  sh(dir, 'git', 'rm', '--quiet', 'src/a.ts');
  const gone = commit(dir, {}, 'the file is gone');
  assert.deepEqual([1, 2, 3, 4].map((l) => movedLine(dir, base, moved, 'src/a.ts', l)), [3, undefined, 4, 5]);
  assert.equal(movedLine(dir, base, changed, 'src/a.ts', 3), undefined);
  assert.equal(movedLine(dir, base, gone, 'src/a.ts', 3), undefined);

  const p: Project = { root: dir, common: join(dir, '.git'), projectDir: '', runner: jest, env: {}, toProject: (f) => f };
  const expected: Expected = {
    exception: 'TypeError', frame: 'src/a.ts:3', js: { platform: 'android', typed: true, frames: [], source: { file: 'src/a.ts', line: 3, fn: 'f' } },
  };
  assert.deepEqual(jsExpectedAt(p, base, base, expected), { expected });
  const there = jsExpectedAt(p, base, moved, expected);
  assert.equal(there.expected.frame, 'src/a.ts:4');
  assert.equal(there.note, "the crash's line src/a.ts:3 is line 4 here");
  const anyLine = jsExpectedAt(p, base, changed, expected);
  assert.equal(anyLine.expected.frame, 'src/a.ts');
  assert.match(anyLine.note!, /changed since \w+: here the test may fail on any line of src\/a\.ts/);
  const at = (line: number) => chainOf(`TypeError: x\n    at f (${ROOT}/src/a.ts:${line}:1)`);
  assert.equal(matchJsFailure(at(9), anyLine.expected, isTest).ok, true);
  assert.equal(matchJsFailure(at(9), there.expected, isTest).ok, false);
  assert.equal(matchJsFailure(chainOf(`TypeError: x\n    at f (${ROOT}/src/b.ts:4:1)`), anyLine.expected, isTest).ok, false);
});

// --- Projects and worktrees ---------------------------------------------------------

const project = (runner: Project['runner']): Project => ({
  root: '/work/app', common: '/work/app/.git', projectDir: '', runner, env: {}, toProject: (p) => p,
});

test('a JS error goes to Jest and a native crash elsewhere, each with a message that says where', () => {
  const js = jsExpected(true);
  assert.throws(() => checkRunnerFits(project(gradle), js), /a JS error .* reproduce it with Jest, from the React Native app's root/);
  assert.doesNotThrow(() => checkRunnerFits(project(jest), js));
  assert.throws(() => checkRunnerFits(project(jest), { exception: 'java.lang.NullPointerException', frame: 'a.B.c' }), /--project-dir android or ios/);
});

test("puts a JS project's worktree outside .git, where Jest and Metro look", (t) => {
  const cache = tempDir(t);
  const saved = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  t.after(() => (saved === undefined ? delete process.env.XDG_CACHE_HOME : (process.env.XDG_CACHE_HOME = saved)));
  assert.equal(worktreePath(project(gradle)), '/work/app/.git/fixcrash/worktree');
  const path = worktreePath(project(jest));
  assert.match(path, new RegExp(`^${cache}/fixcrash/worktrees/app-[0-9a-f]{12}$`));
  assert.ok(!path.split('/').includes('.git'));
});

// --- node_modules (ADR-0005) -------------------------------------------------------

const RNBUILD = fileURLToPath(new URL('../plugin/src/rnbuild.ts', import.meta.url));

test('installs node_modules offline once per lockfile, and only with npm', (t) => {
  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  const app = join(dir, 'app');
  // A fake npm: records the call and makes node_modules.
  writeFiles(dir, { 'bin/npm': `#!/bin/sh\necho "$@" >> "${dir}/npm-calls"\nmkdir -p node_modules\n`, 'app/package-lock.json': '{"v":1}' });
  chmodSync(join(bin, 'npm'), 0o755);
  const deps = (cwd: string) => spawnSync(process.execPath, [RNBUILD, 'deps'], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const calls = () => (existsSync(join(dir, 'npm-calls')) ? readFileSync(join(dir, 'npm-calls'), 'utf8').trim().split('\n') : []);

  assert.equal(deps(app).status, 0);
  assert.deepEqual(calls(), ['ci --offline --no-audit --no-fund']);
  assert.match(deps(app).stdout, /node_modules matches package-lock\.json/);
  assert.equal(calls().length, 1);
  writeFileSync(join(app, 'package-lock.json'), '{"v":2}');
  assert.equal(deps(app).status, 0);
  assert.equal(calls().length, 2);

  writeFiles(dir, { 'yarnapp/yarn.lock': '' });
  const yarn = deps(join(dir, 'yarnapp'));
  assert.equal(yarn.status, 2);
  assert.match(yarn.stdout, /yarn\.lock: fixcrash installs node_modules with only npm for now/);
  assert.match(jest.hint(yarn.stdout) ?? '', /npm only/);
});
