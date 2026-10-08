import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markSession, readRecord, recordEvent, resolveExpectation, sessionActive } from '../src/record.ts';
import { EXPECTED, parserEvent, tempDir } from './helpers.ts';

test('merges events of one issue: distinct expectations and versions, once each', (t) => {
  const gitDir = tempDir(t);

  assert.deepEqual(recordEvent(gitDir, parserEvent()), EXPECTED);
  recordEvent(gitDir, parserEvent('issue-1', { version: { display: '1.1', build: '2' }, revision: 'a'.repeat(40) }));
  recordEvent(gitDir, parserEvent('issue-1', {
    variant: 'v2',
    blameFrame: { symbol: 'com.example.Feed.page' },
    exceptions: [{ type: 'java.lang.IndexOutOfBoundsException', message: '', frames: [{ symbol: 'com.example.Feed.page' }] }],
  }));

  const record = readRecord(gitDir, 'issue-1')!;
  assert.deepEqual(record.expectations.map((e) => `${e.exception} ${e.frame} ${e.variant ?? ''}`), [
    'java.lang.NullPointerException com.example.Parser.parse ',
    'java.lang.IndexOutOfBoundsException com.example.Feed.page v2',
  ]);
  assert.deepEqual(record.versions, [{ display: '1.0', build: '1' }, { display: '1.1', build: '2', revision: 'a'.repeat(40) }]);
});

test('records an event without an expectation, and refuses unsafe ids', (t) => {
  const gitDir = tempDir(t);

  assert.equal(recordEvent(gitDir, parserEvent('issue-2', { blameFrame: undefined })), undefined);
  assert.deepEqual(readRecord(gitDir, 'issue-2')!.expectations, []);
  assert.throws(() => recordEvent(gitDir, parserEvent('../../x')), /not a valid issue id/);
});

test('resolves the expectation from the record, or from the caller when none is recorded', (t) => {
  const gitDir = tempDir(t);
  const other = { exception: 'java.lang.IllegalStateException', frame: 'com.example.Parser.parse' };

  assert.throws(() => resolveExpectation(gitDir, 'issue-1'), /no recorded event for issue issue-1/);
  assert.deepEqual(resolveExpectation(gitDir, 'issue-1', other), { expected: other, source: 'arguments' });

  recordEvent(gitDir, parserEvent());
  assert.deepEqual(resolveExpectation(gitDir, 'issue-1'), { expected: EXPECTED, source: 'event' });
  assert.deepEqual(resolveExpectation(gitDir, 'issue-1', EXPECTED), { expected: EXPECTED, source: 'event' });
  assert.throws(() => resolveExpectation(gitDir, 'issue-1', other), /recorded events expect java.lang.NullPointerException/);

  recordEvent(gitDir, parserEvent('issue-1', { exceptions: [{ type: other.exception, message: '', frames: [{ symbol: other.frame }] }] }));
  assert.throws(() => resolveExpectation(gitDir, 'issue-1'), /several recorded failures/);
  assert.equal(resolveExpectation(gitDir, 'issue-1', other).source, 'event');
});

test('marks sessions', (t) => {
  const gitDir = tempDir(t);

  assert.equal(sessionActive(gitDir, 's-1'), false);
  markSession(gitDir, 's-1');
  assert.equal(sessionActive(gitDir, 's-1'), true);
  assert.equal(sessionActive(gitDir, ''), false);
  assert.equal(sessionActive(gitDir, '../s-1'), false);
});
