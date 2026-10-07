// A fake test runner for fixcrash's own tests. It stands in for Gradle in a
// tiny project and writes JUnit XML with JVM stack traces, like Gradle does.
//
// App code: app/src/main/java/com/example/Parser.kt, with a line
//   `behaviour: bug | wrong | fixed`  (NPE, IllegalStateException, no crash)
//   `api: <name>`                      (optional; tests may need it to compile)
// Tests: app/src/test/java/com/example/<Class>.kt, with lines
//   `test <method> crash | pass | fail | stub`
//   `needs <api>`                      (the file does not compile without it)
//
// usage: node fake-runner.mjs target <Class|Class.method> | suite

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, target] = process.argv.slice(2);
if (!existsSync('local.properties')) {
  console.error('local.properties is missing');
  process.exit(3);
}

const main = readFileSync('app/src/main/java/com/example/Parser.kt', 'utf8');
const behaviour = main.match(/behaviour: (\w+)/)[1];
const apis = [...main.matchAll(/api: (\w+)/g)].map((m) => m[1]);

const testDir = 'app/src/test/java/com/example';
const frames = (top) =>
  [...top, 'java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Unknown Source)', 'org.junit.runners.ParentRunner.run(ParentRunner.java:413)']
    .map((f) => `\tat ${f}`)
    .join('\n');

function outcome(cls, method, kind) {
  const test = `com.example.${cls}.${method}(${cls}.kt:7)`;
  const parse = 'com.example.Parser.parse(Parser.kt:3)';
  if (kind === 'pass') return null;
  if (kind === 'fail') return { type: 'java.lang.AssertionError', text: `java.lang.AssertionError: expected:<1> but was:<2>\n${frames([`org.junit.Assert.fail(Assert.java:89)`, test])}` };
  if (kind === 'stub') return { type: 'java.lang.NullPointerException', text: `java.lang.NullPointerException: stub\n${frames(['com.example.FakeSource.read(FakeSource.kt:4)', parse, test])}` };
  if (behaviour === 'bug') return { type: 'java.lang.NullPointerException', text: `java.lang.NullPointerException: Cannot invoke "getUrl()"\n${frames([parse, test])}` };
  if (behaviour === 'wrong') return { type: 'java.lang.IllegalStateException', text: `java.lang.IllegalStateException: wrong\n${frames([parse, test])}` };
  return null;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let failed = 0;
let ran = 0;
const files = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith('.kt')) : [];
for (const file of files) {
  const cls = file.replace(/\.kt$/, '');
  const src = readFileSync(join(testDir, file), 'utf8');
  for (const need of [...src.matchAll(/needs (\w+)/g)].map((m) => m[1])) {
    if (!apis.includes(need)) {
      console.error(`e: ${file}: unresolved reference '${need}'`);
      process.exit(1);
    }
  }
  const cases = [];
  for (const [, method, kind] of src.matchAll(/test (\w+) (\w+)/g)) {
    const id = `com.example.${cls}`;
    if (mode === 'target' && target !== id && target !== `${id}.${method}`) continue;
    ran++;
    const o = outcome(cls, method, kind);
    if (o) failed++;
    cases.push(o
      ? `  <testcase name="${method}" classname="${id}" time="0.001">\n    <failure message="${esc(o.text.split('\n')[0])}" type="${o.type}">${esc(o.text)}</failure>\n  </testcase>`
      : `  <testcase name="${method}" classname="${id}" time="0.001"/>`);
  }
  if (cases.length === 0) continue;
  mkdirSync('app/build/test-results/test', { recursive: true });
  writeFileSync(
    `app/build/test-results/test/TEST-com.example.${cls}.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.example.${cls}" tests="${cases.length}">\n${cases.join('\n')}\n</testsuite>\n`,
  );
}
if (mode === 'target' && ran === 0) {
  console.error(`No tests found for given includes: [${target}]`);
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
