import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openProject, resolveSite, runContext } from '../plugin/src/run.ts';
import type { Runner } from '../plugin/src/runner.ts';
import type { Expected, Frame } from '../plugin/src/stack.ts';
import { crashingProject, fakeRunner, PARSER } from './helpers.ts';

const SITE = { image: 'App', address: 29516, simulator: true };
const BLAME: Expected = { exception: 'EXC_BREAKPOINT', frame: 'com.example.Screen.show', site: SITE };
const INLINED: Frame[] = [
  { symbol: 'Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value', image: 'App' },
  { symbol: 'specialized Array.subscript.getter', image: 'App' },
  { symbol: 'com.example.Parser.parse', file: 'Parser.kt', line: 3, image: 'App' },
  { symbol: 'com.example.Screen.show', file: 'Screen.kt', line: 9, image: 'App' },
];

/** The fake project's runner, with a release build that exits `buildExit` and these frames at the crash site. */
function siteRunner(frames: Frame[], buildExit = 0): Runner & { builds: number; reads: number } {
  const runner = {
    ...fakeRunner,
    builds: 0,
    reads: 0,
    releaseSteps() {
      runner.builds++;
      return [{ command: [process.execPath, '-e', `process.exit(${buildExit})`] }];
    },
    inlineFrames() {
      runner.reads++;
      return frames;
    },
  };
  return runner;
}

function context(t: Parameters<typeof crashingProject>[0], runner: Runner, expected: Expected = BLAME) {
  const { dir, base } = crashingProject(t);
  const project = openProject(dir, undefined, runner);
  const ctx = runContext(project, { logPrefix: 'site', timeoutMs: 60_000, test: 'T.t', targetFile: 'T.kt', overlay: [], expected });
  return { ctx, base };
}

test('expects the innermost frame in the app\'s sources when the chain ends in the blame frame, once per commit', (t) => {
  const runner = siteRunner(INLINED);
  const { ctx, base } = context(t, runner);
  assert.ok(PARSER.endsWith('Parser.kt'));

  const r = resolveSite(ctx, base);

  assert.deepEqual(r.expected, { ...BLAME, frame: 'com.example.Parser.parse' });
  assert.match(r.note, /^the crash is in com\.example\.Parser\.parse\(Parser\.kt:3\), inlined into com\.example\.Screen\.show \(Swift runtime failure: Unexpectedly found nil/);
  assert.equal(r.chain!.length, 4);
  assert.deepEqual(resolveSite(ctx, base), r);
  assert.deepEqual([runner.builds, runner.reads], [1, 1]);
});

test('keeps the blame frame when the release build\'s frames end elsewhere', (t) => {
  const { ctx, base } = context(t, siteRunner(INLINED.slice(0, 3)));

  const r = resolveSite(ctx, base);

  assert.deepEqual(r.expected, BLAME);
  assert.match(r.note, /not the shipped code: the blame frame com\.example\.Screen\.show stands$/);
});

test('keeps the blame frame when the release build fails, and tries again next time', (t) => {
  const runner = siteRunner(INLINED, 1);
  const { ctx, base } = context(t, runner);

  assert.match(resolveSite(ctx, base).note, /^the release build of [0-9a-f]{12} failed \(.*-release\.log\): the blame frame .* stands$/);
  resolveSite(ctx, base);
  assert.deepEqual([runner.builds, runner.reads], [2, 0]);
});

test('does nothing without a crash site', (t) => {
  const runner = siteRunner(INLINED);
  const expected = { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' };
  const { ctx, base } = context(t, runner, expected);

  assert.deepEqual(resolveSite(ctx, base), { expected, note: '' });
  assert.equal(runner.builds, 0);
});
