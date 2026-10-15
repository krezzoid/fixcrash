import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJUnit } from '../src/junit.ts';
import { matchFailure, parseJvmStack, testFrameDetector } from '../src/stack.ts';

const PAGER = 'io.github.krezzoid.fixcrash.testbed.feed.FeedPager.page';
const noTestCode = () => false;

function gradleFailure(): string {
  const xml = readFileSync(new URL('./fixtures/gradle/TEST-io.github.krezzoid.fixcrash.testbed.feed.FeedPagerTest.xml', import.meta.url), 'utf8');
  return parseJUnit(xml).find((c) => c.failure)!.failure!.text;
}

test('parses a real Gradle stack trace, dropping module and class-loader prefixes', () => {
  const [t, ...rest] = parseJvmStack(gradleFailure());

  assert.equal(rest.length, 0);
  assert.equal(t!.type, 'java.lang.IndexOutOfBoundsException');
  assert.equal(t!.message, 'toIndex = 30');
  assert.deepEqual(t!.frames.slice(0, 3), [
    { symbol: 'java.util.AbstractList.subListRangeCheck' },
    { symbol: 'java.util.ArrayList.subList' },
    { symbol: PAGER, file: 'FeedPager.kt', line: 14 },
  ]);
  assert.ok(t!.frames.some((f) => f.symbol === 'jdk.proxy1.$Proxy4.processTestDefinition'));
});

const CHAINED = `java.lang.RuntimeException: Unable to load
\tat com.example.Loader.load(Loader.kt:20)
\tat com.example.LoaderTest.loads(LoaderTest.kt:9)
\tat org.junit.runners.ParentRunner.run(ParentRunner.java:413)
\tSuppressed: java.lang.IllegalStateException: while closing
\t\tat com.example.Source.close(Source.kt:4)
\t\t... 2 more
\tCaused by: java.lang.NullPointerException: inside suppressed
\t\t... 3 more
Caused by: java.lang.NullPointerException: avatar is null
second line of the message
\tat com.example.Parser.parse(Parser.kt:12)
\tat com.example.Loader.load(Loader.kt:18)
\t... 2 more
`;

test('parses causes, restores shared frames, and keeps suppressed blocks out of the chain', () => {
  const chain = parseJvmStack(CHAINED);

  assert.deepEqual(chain.map((t) => [t.type, t.relation]), [
    ['java.lang.RuntimeException', 'top'],
    ['java.lang.IllegalStateException', 'suppressed'],
    ['java.lang.NullPointerException', 'suppressed'],
    ['java.lang.NullPointerException', 'cause'],
  ]);
  const cause = chain[3]!;
  assert.equal(cause.message, 'avatar is null\nsecond line of the message');
  assert.deepEqual(cause.frames.map((f) => f.symbol), [
    'com.example.Parser.parse', 'com.example.Loader.load', 'com.example.LoaderTest.loads', 'org.junit.runners.ParentRunner.run',
  ]);
});

test('returns nothing for text that is not a stack trace', () => {
  assert.deepEqual(parseJvmStack('expected:<1> but was:<2>'), []);
  assert.deepEqual(parseJvmStack(''), []);
});

test('matches the crash: type and frame, anywhere in the cause chain', () => {
  const m = matchFailure(parseJvmStack(CHAINED), { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' }, noTestCode);

  assert.ok(m.ok);
  assert.equal(m.throwable.relation, 'cause');
  assert.equal(m.frameIndex, 0);
});

test('does not match a type that only appears in a suppressed block', () => {
  const m = matchFailure(parseJvmStack(CHAINED), { exception: 'java.lang.IllegalStateException', frame: 'com.example.Source.close' }, noTestCode);

  assert.deepEqual(m, { ok: false, reason: 'failed with java.lang.RuntimeException <- java.lang.NullPointerException, not java.lang.IllegalStateException' });
});

test('does not match when the frame is missing from the stack', () => {
  const chain = parseJvmStack(gradleFailure());
  const m = matchFailure(chain, { exception: 'java.lang.IndexOutOfBoundsException', frame: 'io.github.krezzoid.fixcrash.testbed.feed.FeedPager.load' }, noTestCode);

  assert.equal(m.ok, false);
  assert.match(!m.ok ? m.reason : '', /does not pass through .*FeedPager.load/);
});

test('does not match an exception thrown from test code above the frame', () => {
  const chain = parseJvmStack(`java.lang.NullPointerException: stub
\tat com.example.FakeSource.read(FakeSource.kt:4)
\tat com.example.Parser.parse(Parser.kt:12)
\tat com.example.ParserTest.parses(ParserTest.kt:9)`);
  const isTest = testFrameDetector(['app/src/test/java/com/example/FakeSource.kt', 'app/src/test/java/com/example/ParserTest.kt']);

  const m = matchFailure(chain, { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' }, isTest);

  assert.equal(m.ok, false);
  assert.match(!m.ok ? m.reason : '', /thrown from test code at com.example.FakeSource.read\(FakeSource.kt:4\)/);
});

test('tells test frames from app frames with the same file name by package', () => {
  const isTest = testFrameDetector(['app/src/test/java/com/example/testing/Utils.kt']);

  assert.equal(isTest({ symbol: 'com.example.testing.UtilsKt.fake', file: 'Utils.kt', line: 3 }), true);
  assert.equal(isTest({ symbol: 'com.example.app.UtilsKt.parse', file: 'Utils.kt', line: 3 }), false);
  assert.equal(isTest({ symbol: 'java.util.ArrayList.subList' }), false);
});

test('matches a Swift frame with or without the specialization prefix', () => {
  const frames = [
    { symbol: '_assertionFailure(_:_:file:line:flags:)', image: 'libswiftCore.dylib' },
    { symbol: 'FeedPager.page(_:)', file: 'FeedPager.swift', line: 16, image: 'App.debug.dylib' },
    { symbol: 'FeedPagerTests.testLastPage()', file: 'FeedPagerTests.swift', line: 9, image: 'AppTests' },
  ];
  const chain = [{ type: 'EXC_BREAKPOINT', message: '', frames, relation: 'top' as const }];

  const m = matchFailure(chain, { exception: 'EXC_BREAKPOINT', frame: 'specialized FeedPager.page(_:)' }, noTestCode);

  assert.ok(m.ok);
  assert.equal(m.frameIndex, 1);
});
