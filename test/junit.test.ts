import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeEntities, parseJUnit, parseXml, selectCases, type TestCase } from '../src/junit.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/gradle/${name}`, import.meta.url), 'utf8');

test('parses a Gradle report: passed and failed cases, failure type and stack', () => {
  const cases = parseJUnit(fixture('TEST-io.github.krezzoid.fixcrash.testbed.profile.ProfileParserTest.xml'));

  assert.deepEqual(cases.map((c) => [c.name, c.status]), [['parsesFullProfile', 'passed'], ['parsesProfileWithoutAvatar', 'failed']]);
  const failure = cases[1]!.failure!;
  assert.equal(failure.type, 'java.lang.NullPointerException');
  assert.match(failure.message, /^java.lang.NullPointerException: Cannot invoke "io.github/);
  assert.match(failure.text, /\n\tat io.github.krezzoid.fixcrash.testbed.profile.ProfileParser.parse\(ProfileParser.kt:12\)\n/);
});

test('reads error, skipped, CDATA and self-closing elements', () => {
  const cases = parseJUnit(`<?xml version="1.0"?>
    <!-- written by hand -->
    <testsuites>
      <testsuite name="s">
        <testcase classname="a.B" name="ok"/>
        <testcase classname="a.B" name="skip"><skipped/></testcase>
        <testcase classname="a.B" name="err"><error type="java.lang.Error"><![CDATA[java.lang.Error: <raw> & text]]></error></testcase>
      </testsuite>
    </testsuites>`);

  assert.deepEqual(cases.map((c) => c.status), ['passed', 'skipped', 'failed']);
  assert.equal(cases[2]!.failure!.text, 'java.lang.Error: <raw> & text');
});

test('decodes XML entities', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;&#x42;'), `<a> & "b" 'c' AB`);
});

test('rejects malformed XML', () => {
  assert.throws(() => parseXml('<a><b></a>'), /malformed XML/);
  assert.throws(() => parseXml('<a>'), /not closed/);
});

test('selects cases by method, by class, and parameterized variants', () => {
  const c = (classname: string, name: string): TestCase => ({ classname, name, status: 'passed' });
  const cases = [c('a.FooTest', 'one'), c('a.FooTest', 'two'), c('a.FooTest', 'one[0]'), c('a.FooTest', 'oneMore'), c('a.BarTest', 'one')];

  assert.deepEqual(selectCases(cases, 'a.FooTest.one').map((x) => x.name), ['one', 'one[0]']);
  assert.deepEqual(selectCases(cases, 'a.FooTest').map((x) => x.name), ['one', 'two', 'one[0]', 'oneMore']);
  assert.deepEqual(selectCases(cases, 'a.FooTest.three'), []);
});
