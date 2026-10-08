import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../src/record.ts';
import { reproduce, type ReproduceOptions } from '../src/reproduce.ts';
import { VerifyError } from '../src/run.ts';
import { commit, crashingProject, fakeRunner, PARSER, parserEvent, TEST_ID, TESTS, writeFiles } from './helpers.ts';

function run(dir: string, base: string, extra: Partial<ReproduceOptions> = {}) {
  const lines: string[] = [];
  const result = reproduce({
    cwd: dir, issue: 'issue-1', test: TEST_ID, base, hypothesis: 'avatar is missing', maxAttempts: 3, maxHypotheses: 2,
    run: 'r1', runner: fakeRunner, log: (l) => lines.push(l), ...extra,
  });
  return { ...result, output: lines.join('\n') };
}

/** The crashing project, moved on: HEAD has an unrelated commit, the event is recorded. */
function project(t: Parameters<typeof crashingProject>[0]) {
  const p = crashingProject(t);
  commit(p.dir, { 'README.md': 'later\n' }, 'later');
  recordEvent(join(p.dir, '.git'), parserEvent());
  return p;
}

test('runs the uncommitted test at the crashing version and says it reproduces the crash', (t) => {
  const { dir, base } = project(t);
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n' });

  const r = run(dir, base);

  assert.equal(r.status, 'reproduced', r.output);
  assert.equal(r.expectedSource, 'event');
  assert.equal(r.record!.commit, base);
  assert.match(r.output, /attempt 1 of 3/);
  assert.match(r.output, /REPRODUCED at \w+: fails as the crash did: java.lang.NullPointerException at com.example.Parser.parse\(Parser.kt:3\)/);
  assert.deepEqual(r.log.attempts.map((a) => [a.hypothesis, a.reproduced]), [['avatar is missing', true]]);
});

test('says why a test does not reproduce the crash', (t) => {
  const { dir, base } = project(t);
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar pass\n' });

  const r = run(dir, base);

  assert.equal(r.status, 'not-reproduced');
  assert.match(r.output, /NOT REPRODUCED: .*passed at \w+: it must fail there.*2 attempts left/);
});

test('stops at the attempt budget and lists what was tried', (t) => {
  const { dir, base } = project(t);
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar pass\n' });

  run(dir, base, { maxAttempts: 2 });
  run(dir, base, { maxAttempts: 2, hypothesis: 'avatar is null' });
  const r = run(dir, base, { maxAttempts: 2 });

  assert.equal(r.status, 'budget-spent');
  assert.match(r.output, /BUDGET SPENT: 2 of 2 test attempts used\. Stop and report/);
  assert.match(r.output, /- avatar is missing: .*passed/);
  assert.match(r.output, /- avatar is null: /);
  assert.equal(run(dir, base, { maxAttempts: 2, run: 'r2' }).status, 'not-reproduced', 'a new run has a new budget');
});

test('stops at the hypothesis budget, and lets a known hypothesis try again', (t) => {
  const { dir, base } = project(t);
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar pass\n' });

  run(dir, base, { maxHypotheses: 1, maxAttempts: 5 });
  assert.equal(run(dir, base, { maxHypotheses: 1, maxAttempts: 5 }).status, 'not-reproduced');
  const r = run(dir, base, { maxHypotheses: 1, maxAttempts: 5, hypothesis: 'something else' });

  assert.equal(r.status, 'budget-spent');
  assert.match(r.reason, /1 of 1 hypotheses used/);
});

test('needs a new test in the working tree, and only overlays test files', (t) => {
  const { dir, base } = project(t);
  assert.throws(() => run(dir, base), (e) => e instanceof VerifyError && /write the test first/.test(e.message));

  // App code changed in the working tree does not reach the crashing version.
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n', [PARSER]: 'behaviour: fixed\n' });
  assert.equal(run(dir, base).status, 'reproduced');
  assert.throws(() => run(dir, base, { test: 'com.example.OtherTest.x' }), /not in the changed test files/);
});

test('finds a changed test file that is already tracked', (t) => {
  const { dir, base } = project(t);
  commit(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar pass\n' }, 'a passing test');
  writeFiles(dir, { [`${TESTS}/ParserTest.kt`]: 'test parsesWithoutAvatar crash\n' });

  assert.equal(run(dir, base).status, 'reproduced');
});
