import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectCases } from '../plugin/src/junit.ts';
import { matchFailure } from '../plugin/src/stack.ts';
import {
  crashLogsOf, parseAtos, parseCrashLog, parseOpenStep, pickScheme, pickSimulator, resultBundles, testCasesOf, testTargetOf, testTargetsOf,
  xcodebuild,
} from '../plugin/src/xcode.ts';
import { tempDir, writeFiles } from './helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/xcode/${name}`, import.meta.url), 'utf8');
const PROJECT = { flag: '-project' as const, path: 'App.xcodeproj' };
const EXPECTED = { exception: 'EXC_BREAKPOINT', frame: 'ProfileParser.parse(_:)' };

test('parses an OpenStep property list: dictionaries, lists, quoted and bare strings, comments', () => {
  const plist = parseOpenStep('// !$*UTF8*$!\n{ a = 1; /* note */ b = ( x, "y z", ); c = { d = "q\\"uote\\n"; }; e = Base.lproj/Main.storyboard; f = "$(SRCROOT)/App"; }');

  assert.deepEqual(plist, { a: '1', b: ['x', 'y z'], c: { d: 'q"uote\n' }, e: 'Base.lproj/Main.storyboard', f: '$(SRCROOT)/App' });
  assert.throws(() => parseOpenStep('{ a = 1 }'), /malformed property list .*expected ;/);
});

test('maps folder-synchronized test targets to their folders, and finds UI test targets', () => {
  const targets = testTargetsOf(fixture('project.pbxproj'));

  assert.deepEqual([...targets.folders], [['App', 'App'], ['AppTests', 'AppTests'], ['AppUITests', 'AppUITests']]);
  assert.deepEqual(targets.uiTests, ['AppUITests']);
});

test('tells a test file\'s target: its synchronized folder, else the nearest *Tests folder', () => {
  const targets = testTargetsOf(fixture('project.pbxproj'));

  assert.equal(testTargetOf('AppTests/Profile/ProfileParserTests.swift', targets), 'AppTests');
  assert.equal(testTargetOf('Tests/CoreTests/ParserTests.swift', targets), 'CoreTests');
  assert.equal(testTargetOf('Sources/Parser.swift', targets), undefined);
});

test('picks the scheme: the setting, the only one, or the one named like the project', () => {
  assert.equal(pickScheme(['App'], PROJECT, {}), 'App');
  assert.equal(pickScheme(['App', 'App Staging'], PROJECT, {}), 'App');
  assert.equal(pickScheme(['Alpha', 'Beta'], PROJECT, {}), undefined);
  assert.equal(pickScheme(['Alpha', 'Beta'], PROJECT, { FIXCRASH_XCODE_SCHEME: 'Beta' }), 'Beta');
});

test('picks a booted iPhone, else an iPhone on the newest iOS', () => {
  const devices = (booted: boolean) => JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ udid: 'OLD', name: 'iPhone 16', state: booted ? 'Booted' : 'Shutdown', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
        { udid: 'PAD', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
        { udid: 'NEW', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'WATCH', name: 'Apple Watch', state: 'Booted' }],
    },
  });

  assert.equal(pickSimulator(devices(false)), 'NEW');
  assert.equal(pickSimulator(devices(true)), 'OLD');
  assert.equal(pickSimulator('{"devices":{}}'), undefined);
});

test('reads test cases from a result bundle, with a failure message for each failed one', () => {
  const cases = testCasesOf(JSON.parse(fixture('tests.json')));

  assert.deepEqual(cases.map((c) => [c.identifier, c.classname, c.name, c.status]), [
    ['ProfileParserTests/testParsesFullProfile()', 'ProfileParserTests', 'testParsesFullProfile', 'passed'],
    ['ProfileParserTests/testParsesProfileWithoutAvatar()', 'ProfileParserTests', 'testParsesProfileWithoutAvatar', 'failed'],
    ['FeedPagerTests/lastPartialPage()', 'FeedPagerTests', 'lastPartialPage', 'failed'],
    ['FeedPagerTests/emptyFeed()', 'FeedPagerTests', 'emptyFeed', 'skipped'],
  ]);
  assert.match(cases[1]!.failure!.text, /^Crash: App at /);
  assert.equal(selectCases(cases, 'FeedPagerTests.lastPartialPage()').length, 1);
  assert.equal(selectCases(cases, 'ProfileParserTests.testParsesProfileWithoutAvatar').length, 1);
});

test('finds the crash log attached to each crashed test', () => {
  assert.deepEqual([...crashLogsOf(JSON.parse(fixture('manifest.json')))], [
    ['ProfileParserTests/testParsesProfileWithoutAvatar()', '0000000A-0000-0000-0000-00000000000A.ips'],
  ]);
});

test('reads the crashed thread of a crash log, each frame with its binary', () => {
  const [t, ...rest] = parseCrashLog(fixture('crash.ips'));

  assert.equal(rest.length, 0);
  assert.equal(t!.type, 'EXC_BREAKPOINT');
  assert.equal(t!.message, 'Trace/BPT trap: 5');
  assert.deepEqual(t!.frames.slice(1, 5), [
    { symbol: '_assertionFailure(_:_:file:line:flags:)', image: 'libswiftCore.dylib' },
    { symbol: 'ProfileParser.parse(_:)', file: 'ProfileParser.swift', line: 10, image: 'App.debug.dylib' },
    { symbol: 'ProfileParserTests.testParsesProfileWithoutAvatar()', file: 'ProfileParserTests.swift', line: 12, image: 'AppTests' },
    { symbol: '@objc ProfileParserTests.testParsesProfileWithoutAvatar()', image: 'AppTests' },
  ]);
  assert.deepEqual(t!.frames[5], { symbol: 'XCTestCore + 600', image: 'XCTestCore' });
  assert.deepEqual(parseCrashLog('{}\n{"threads":[]}'), []);
});

test('a crash log matches the crash unless test code is above the frame', () => {
  const chain = parseCrashLog(fixture('crash.ips'));
  const isTestImage = (f: { image?: string }) => f.image === 'AppTests';

  assert.ok(matchFailure(chain, EXPECTED, isTestImage).ok);
  const m = matchFailure(chain, { exception: 'EXC_BREAKPOINT', frame: '@objc ProfileParserTests.testParsesProfileWithoutAvatar()' }, isTestImage);
  assert.equal(m.ok, false);
  assert.match(!m.ok ? m.reason : '', /thrown from test code at ProfileParserTests\.testParsesProfileWithoutAvatar\(\)/);
  assert.equal(matchFailure(chain, { ...EXPECTED, exception: 'EXC_BAD_ACCESS' }, isTestImage).ok, false);
});

test('builds once, then runs the one test with a timeout and a retry; the suite skips UI tests', (t) => {
  const dir = tempDir(t);
  writeFiles(dir, {
    'App.xcodeproj/project.pbxproj': fixture('project.pbxproj'),
    'App.xcodeproj/xcshareddata/xcschemes/App.xcscheme': '<Scheme/>\n',
  });
  const saved = process.env.FIXCRASH_XCODE_DESTINATION;
  process.env.FIXCRASH_XCODE_DESTINATION = 'platform=iOS Simulator,name=iPhone 17';
  t.after(() => {
    if (saved === undefined) delete process.env.FIXCRASH_XCODE_DESTINATION;
    else process.env.FIXCRASH_XCODE_DESTINATION = saved;
  });
  const runner = xcodebuild(dir);
  const dirs = { out: '/out', cache: '/cache' };
  const common = ['-project', 'App.xcodeproj', '-scheme', 'App', '-destination', 'platform=iOS Simulator,name=iPhone 17', '-derivedDataPath', '/cache/DerivedData'];

  const [build, run] = runner.targetSteps('ProfileParserTests.testParsesProfileWithoutAvatar', 'AppTests/ProfileParserTests.swift', dirs);

  assert.deepEqual(build, { command: ['xcodebuild', 'build-for-testing', ...common] });
  assert.deepEqual(run!.command, [
    'xcodebuild', 'test-without-building', ...common, '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never',
    '-resultBundlePath', '/out/tests.xcresult',
    '-only-testing:AppTests/ProfileParserTests/testParsesProfileWithoutAvatar',
  ]);
  assert.equal(run!.timeoutMs, 2 * 60_000);
  assert.ok(run!.retry!.includes('/out/tests-retry.xcresult'));
  assert.equal(runner.targetSteps('FeedPagerTests.lastPartialPage()', 'AppTests/FeedPagerTests.swift', dirs)[1]!.command.at(-1), '-only-testing:AppTests/FeedPagerTests/lastPartialPage()');
  assert.equal(runner.suiteSteps(dirs)[1]!.command.at(-1), '-skip-testing:AppUITests');
  assert.throws(() => runner.targetSteps('T.t', 'Sources/T.swift', dirs), /cannot tell the test target of Sources\/T\.swift/);
});

test('finds the test file named after the class, and tells test images', (t) => {
  const dir = tempDir(t);
  writeFiles(dir, { 'App.xcodeproj/project.pbxproj': fixture('project.pbxproj') });
  const runner = xcodebuild(dir);
  const files = ['AppTests/Profile/ProfileParserTests.swift', 'AppTests/FeedPagerTests.swift', 'App/ProfileParser.swift'];

  assert.equal(runner.isTestFile('AppTests/Profile/ProfileParserTests.swift'), true);
  assert.equal(runner.isTestFile('App/ProfileParser.swift'), false);
  assert.equal(runner.locateTest('ProfileParserTests.testParsesProfileWithoutAvatar', files), 'AppTests/Profile/ProfileParserTests.swift');
  assert.equal(runner.locateTest('FeedPagerTests.lastPartialPage()', files), 'AppTests/FeedPagerTests.swift');
  assert.equal(runner.locateTest('FeedPagerTests', files), 'AppTests/FeedPagerTests.swift');
  assert.equal(runner.locateTest('MissingTests.x', files), undefined);
  assert.deepEqual([...runner.testImages!(files.slice(0, 2))], ['AppTests']);
});

test('reads atos frames, innermost first, with the source file when there is one', () => {
  const out = [
    'Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value (in App) (/<compiler-generated>:0)',
    'ProfileParser.parse(_:) (in App) (ProfileParser.swift:10)',
    'closure #1 in ProfileViewController.showProfile() (in App) (ProfileViewController.swift:50)',
    'specialized Array.subscript.getter (in App) + 12',
    '',
  ].join('\n');

  assert.deepEqual(parseAtos(out), [
    { symbol: 'Swift runtime failure: Unexpectedly found nil while unwrapping an Optional value', image: 'App' },
    { symbol: 'ProfileParser.parse(_:)', image: 'App', file: 'ProfileParser.swift', line: 10 },
    { symbol: 'closure #1 in ProfileViewController.showProfile()', image: 'App', file: 'ProfileViewController.swift', line: 50 },
    { symbol: 'specialized Array.subscript.getter', image: 'App' },
  ]);
});

test('reads only finished result bundles, the retry\'s first', (t) => {
  const out = tempDir(t);
  writeFiles(out, {
    'tests.xcresult/Info.plist': '<plist/>\n',
    'tests-retry.xcresult/database.sqlite3': '',
  });

  assert.deepEqual(resultBundles(out), [`${out}/tests.xcresult`]);
  writeFiles(out, { 'tests-retry.xcresult/Info.plist': '<plist/>\n' });
  assert.deepEqual(resultBundles(out), [`${out}/tests-retry.xcresult`, `${out}/tests.xcresult`]);
});

test('takes xcodebuild\'s form of a test id too', (t) => {
  const dir = tempDir(t);
  writeFiles(dir, { 'App.xcodeproj/project.pbxproj': fixture('project.pbxproj') });
  const runner = xcodebuild(dir);

  assert.equal(runner.testId!('AppTests/ProfileParserTests/testParsesProfileWithoutAvatar'), 'ProfileParserTests.testParsesProfileWithoutAvatar');
  assert.equal(runner.testId!('AppTests/FeedPagerTests/lastPartialPage()'), 'FeedPagerTests.lastPartialPage()');
  assert.equal(runner.testId!('ProfileParserTests.testParsesProfileWithoutAvatar'), 'ProfileParserTests.testParsesProfileWithoutAvatar');
});
