// Xcode projects: unit tests that xcodebuild runs on an iOS simulator.
//
// - It builds once (`build-for-testing`), then runs the tests
//   (`test-without-building`). A test that crashes kills the app that hosts
//   it, and xcodebuild sometimes hangs after that: the test step has a short
//   timeout and one retry.
// - Parallel testing is off: it boots a clone of the simulator for every run.
// - Results come from the result bundle, and a crashed test's stack from the
//   crash log attached to it (docs/RESEARCH.md §7, step 5.4).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCase, TestStatus } from './junit.ts';
import type { RunDirs, Runner, Step } from './runner.ts';
import type { CrashSite, Frame, Throwable } from './stack.ts';

/** One crashing test takes 20 to 30 s with the app built; a hang goes on for good. */
const TARGET_TEST_TIMEOUT_MS = 2 * 60_000;
const TEST_FILE = /(^|\/)[A-Za-z0-9_]*Tests\/.+\.swift$/;
const UI_TEST_PRODUCT = 'com.apple.product-type.bundle.ui-testing';
const XCODE_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

export interface XcodeContainer {
  flag: '-workspace' | '-project';
  /** Relative to the project directory. */
  path: string;
}

/** The workspace (CocoaPods and others make one) or, without one, the project. */
export function findXcodeContainer(projectDir: string): XcodeContainer | undefined {
  let entries: string[];
  try {
    entries = readdirSync(projectDir).sort();
  } catch {
    return undefined;
  }
  const workspace = entries.find((e) => e.endsWith('.xcworkspace'));
  if (workspace) return { flag: '-workspace', path: workspace };
  const project = entries.find((e) => e.endsWith('.xcodeproj'));
  return project ? { flag: '-project', path: project } : undefined;
}

// --- project.pbxproj -------------------------------------------------------

export type Plist = string | Plist[] | { [key: string]: Plist };

/** Parses an old-style (OpenStep) property list: the format of `project.pbxproj`. */
export function parseOpenStep(text: string): Plist {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`malformed property list at offset ${i}: ${what}`);
  };
  const skip = () => {
    for (;;) {
      if (/\s/.test(text[i] ?? '')) i++;
      else if (text.startsWith('//', i)) i = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i) + 1;
      else if (text.startsWith('/*', i)) i = text.indexOf('*/', i + 2) < 0 ? fail('unclosed comment') : text.indexOf('*/', i + 2) + 2;
      else return;
    }
  };
  const expect = (c: string) => {
    skip();
    if (text[i] !== c) fail(`expected ${c}`);
    i++;
  };
  const BARE = /[A-Za-z0-9_$+/:.-]+/y;
  const value = (): Plist => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const dict: Record<string, Plist> = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return dict;
        }
        const key = value();
        if (typeof key !== 'string') fail('a key must be a string');
        expect('=');
        dict[key as string] = value();
        expect(';');
      }
    }
    if (c === '(') {
      i++;
      const list: Plist[] = [];
      for (;;) {
        skip();
        if (text[i] === ')') {
          i++;
          return list;
        }
        list.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ')') fail('expected , or )');
      }
    }
    if (c === '"') {
      i++;
      let out = '';
      while (text[i] !== '"') {
        if (i >= text.length) fail('unclosed string');
        if (text[i] === '\\') {
          const e = text[i + 1] ?? '';
          out += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e;
          i += 2;
        } else {
          out += text[i++];
        }
      }
      i++;
      return out;
    }
    BARE.lastIndex = i;
    const m = BARE.exec(text);
    if (!m) fail('expected a value');
    i += m![0].length;
    return m![0];
  };
  return value();
}

export interface TestTargets {
  /** Folder (relative to the project directory) of each folder-synchronized test target, to its name. */
  folders: Map<string, string>;
  /** UI test targets: a unit test run skips them. */
  uiTests: string[];
}

type Obj = Record<string, Plist>;

export function testTargetsOf(pbxproj: string): TestTargets {
  const root = parseOpenStep(pbxproj) as Obj;
  const objects = (root.objects ?? {}) as Record<string, Obj>;
  const folders = new Map<string, string>();
  const uiTests: string[] = [];
  for (const o of Object.values(objects)) {
    if (o.isa !== 'PBXNativeTarget' || typeof o.name !== 'string') continue;
    if (o.productType === UI_TEST_PRODUCT) uiTests.push(o.name);
    for (const id of (o.fileSystemSynchronizedGroups ?? []) as string[]) {
      const group = objects[id];
      if (group?.isa === 'PBXFileSystemSynchronizedRootGroup' && typeof group.path === 'string') folders.set(group.path, o.name);
    }
  }
  return { folders, uiTests: uiTests.sort() };
}

/**
 * The test target a test file belongs to: the folder-synchronized target
 * whose folder holds it, else the nearest enclosing folder named `*Tests`.
 */
export function testTargetOf(testFile: string, targets: TestTargets): string | undefined {
  let best: [string, string] | undefined;
  for (const [folder, name] of targets.folders) {
    if (testFile.startsWith(`${folder}/`) && (!best || folder.length > best[0].length)) best = [folder, name];
  }
  if (best) return best[1];
  return testFile.split('/').slice(0, -1).reverse().find((d) => /Tests$/.test(d));
}

// --- Schemes and simulators -------------------------------------------------

function schemesIn(projectDir: string, container: XcodeContainer): string[] {
  const dirs = [join(projectDir, container.path, 'xcshareddata', 'xcschemes')];
  if (container.flag === '-workspace') {
    for (const e of readdirSync(projectDir)) {
      if (e.endsWith('.xcodeproj')) dirs.push(join(projectDir, e, 'xcshareddata', 'xcschemes'));
    }
  }
  const names = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.xcscheme')) names.add(f.slice(0, -'.xcscheme'.length));
  }
  return [...names].sort();
}

/** The shared scheme to test with: `FIXCRASH_XCODE_SCHEME`, the only one, or the one named like the container. */
export function pickScheme(schemes: string[], container: XcodeContainer, env: NodeJS.ProcessEnv): string | undefined {
  if (env.FIXCRASH_XCODE_SCHEME) return env.FIXCRASH_XCODE_SCHEME;
  if (schemes.length === 1) return schemes[0];
  const named = container.path.replace(/\.(xcworkspace|xcodeproj)$/, '');
  return schemes.includes(named) ? named : undefined;
}

interface SimDevice {
  udid: string;
  name: string;
  state?: string;
  isAvailable?: boolean;
}

/** From `xcrun simctl list devices available --json`: a booted iPhone, else an iPhone on the newest iOS. */
export function pickSimulator(json: string): string | undefined {
  const { devices } = JSON.parse(json) as { devices: Record<string, SimDevice[]> };
  const version = (runtime: string) => (runtime.match(/iOS-([\d-]+)$/)?.[1] ?? '0').split('-').map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (b[k] ?? 0) - (a[k] ?? 0);
    return 0;
  };
  const phones = Object.keys(devices)
    .filter((r) => /SimRuntime\.iOS-/.test(r))
    .sort((a, b) => newer(version(a), version(b)))
    .flatMap((r) => devices[r]!.filter((d) => d.isAvailable !== false && /^iPhone/.test(d.name)));
  return (phones.find((d) => d.state === 'Booted') ?? phones[0])?.udid;
}

/** Xcode's developer directory when `xcode-select` points at the Command Line Tools, which have no xcodebuild. */
function developerDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DEVELOPER_DIR) return undefined;
  const selected = spawnSync('xcode-select', ['-p'], { env, encoding: 'utf8' });
  const path = selected.status === 0 ? selected.stdout.trim() : '';
  if (path && !path.includes('CommandLineTools')) return undefined;
  return existsSync(XCODE_DEVELOPER_DIR) ? XCODE_DEVELOPER_DIR : undefined;
}

/** The environment for fixcrash's own xcrun calls. */
function xcodeEnv(): NodeJS.ProcessEnv {
  const dir = developerDir(process.env);
  return dir ? { ...process.env, DEVELOPER_DIR: dir } : process.env;
}

function xcrun(args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync('xcrun', args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`xcrun ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  return r.stdout;
}

// --- Results ----------------------------------------------------------------

interface TestNode {
  name?: string;
  nodeType?: string;
  nodeIdentifier?: string;
  result?: string;
  children?: TestNode[];
}

const STATUS: Record<string, TestStatus> = { Passed: 'passed', Failed: 'failed', Skipped: 'skipped', 'Expected Failure': 'passed' };

export interface XcodeTestCase extends TestCase {
  /** The result bundle's id, `Suite/test()`: crash logs are filed under it. */
  identifier: string;
}

/** Test cases from `xcresulttool get test-results tests`. */
export function testCasesOf(tree: { testNodes?: TestNode[] }): XcodeTestCase[] {
  const cases: XcodeTestCase[] = [];
  const messages = (n: TestNode): string[] =>
    (n.children ?? []).flatMap((c) => (c.nodeType === 'Failure Message' ? [c.name ?? ''] : messages(c)));
  const walk = (n: TestNode) => {
    if (n.nodeType === 'Test Case' && n.nodeIdentifier) {
      const slash = n.nodeIdentifier.lastIndexOf('/');
      const status = STATUS[n.result ?? ''] ?? 'failed';
      const c: XcodeTestCase = {
        identifier: n.nodeIdentifier,
        classname: n.nodeIdentifier.slice(0, slash),
        name: n.nodeIdentifier.slice(slash + 1).replace(/\(\)$/, ''),
        status,
      };
      if (status === 'failed') {
        const text = messages(n).join('\n');
        c.failure = { type: '', message: text.split('\n')[0] ?? '', text };
      }
      cases.push(c);
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  for (const n of tree.testNodes ?? []) walk(n);
  return cases;
}

interface AttachmentManifest {
  testIdentifier?: string;
  attachments?: { exportedFileName?: string; suggestedHumanReadableName?: string; isAssociatedWithFailure?: boolean }[];
}

/** The crash log of each test that crashed, from `xcresulttool export attachments`'s manifest. */
export function crashLogsOf(manifest: AttachmentManifest[]): Map<string, string> {
  const logs = new Map<string, string>();
  for (const entry of manifest) {
    const log = entry.attachments?.find((a) => a.isAssociatedWithFailure && /\.ips$/.test(a.exportedFileName ?? ''));
    if (entry.testIdentifier && log?.exportedFileName) logs.set(entry.testIdentifier, log.exportedFileName);
  }
  return logs;
}

interface IpsFrame {
  symbol?: string;
  sourceFile?: string;
  sourceLine?: number;
  imageIndex?: number;
  imageOffset?: number;
}

/**
 * The crashed thread of an Apple crash log (`.ips`: a JSON header line, then
 * a JSON body), as one throwable: the Mach exception type, and the frames
 * with the binary each one is in.
 */
export function parseCrashLog(text: string): Throwable[] {
  const body = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    exception?: { type?: string };
    termination?: { indicator?: string };
    faultingThread?: number;
    threads?: { triggered?: boolean; frames?: IpsFrame[] }[];
    usedImages?: { name?: string }[];
  };
  const threads = body.threads ?? [];
  const crashed = threads.find((t) => t.triggered) ?? threads[body.faultingThread ?? -1];
  if (!body.exception?.type || !crashed) return [];
  const frames = (crashed.frames ?? []).map((f): Frame => {
    const image = body.usedImages?.[f.imageIndex ?? -1]?.name;
    const frame: Frame = { symbol: f.symbol ?? `${image ?? '?'} + ${f.imageOffset ?? 0}` };
    if (f.sourceFile && !f.sourceFile.startsWith('/<')) frame.file = f.sourceFile;
    if (f.sourceLine !== undefined && frame.file) frame.line = f.sourceLine;
    if (image) frame.image = image;
    return frame;
  });
  return [{ type: body.exception.type, message: body.termination?.indicator ?? '', frames, relation: 'top' }];
}

/** The test cases in a run's result bundle, with each crashed test's crash log parsed. */
function readResults(out: string, env: NodeJS.ProcessEnv): TestCase[] {
  const bundle = ['tests-retry.xcresult', 'tests.xcresult'].map((n) => join(out, n)).find((p) => existsSync(p));
  if (!bundle) return [];
  const cases = testCasesOf(JSON.parse(xcrun(['xcresulttool', 'get', 'test-results', 'tests', '--path', bundle], env)));
  if (!cases.some((c) => c.status === 'failed')) return cases;
  const attachments = join(out, 'attachments');
  xcrun(['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', attachments], env);
  const manifest = join(attachments, 'manifest.json');
  const logs = existsSync(manifest) ? crashLogsOf(JSON.parse(readFileSync(manifest, 'utf8'))) : new Map<string, string>();
  for (const c of cases) {
    const log = logs.get(c.identifier);
    if (c.failure && log) c.failure.chain = parseCrashLog(readFileSync(join(attachments, log), 'utf8'));
  }
  return cases;
}

/** `atos -i` output, innermost frame first: `symbol (in Image) (File.swift:10)`. */
export function parseAtos(output: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.*) \(in ([^)]+)\)(?: \((.+):(\d+)\)| \+ \d+)?$/);
    if (!m) continue;
    const frame: Frame = { symbol: m[1]!, image: m[2]! };
    if (m[3] && !m[3].startsWith('/<')) {
      frame.file = m[3];
      frame.line = Number(m[4]);
    }
    frames.push(frame);
  }
  return frames;
}

// --- The runner -------------------------------------------------------------

/** `Class.method` → `Class/method`; a Swift Testing id keeps its `()`. */
const onlyTestingPath = (testId: string) => testId.replace(/\.(?=[^.]*$)/, '/');

export function xcodebuild(projectDir: string): Runner {
  const container = findXcodeContainer(projectDir);
  if (!container) throw new Error(`no Xcode workspace or project in ${projectDir}`);
  const pbxprojOwner = container.flag === '-project'
    ? container.path
    : readdirSync(projectDir).sort().find((e) => e.endsWith('.xcodeproj'));
  const pbxproj = pbxprojOwner ? join(projectDir, pbxprojOwner, 'project.pbxproj') : undefined;
  let targets: TestTargets | undefined;
  const testTargets = (): TestTargets => {
    targets ??= pbxproj && existsSync(pbxproj) ? testTargetsOf(readFileSync(pbxproj, 'utf8')) : { folders: new Map(), uiTests: [] };
    return targets;
  };
  let destination: string | undefined;
  const schemeArgs = (): string[] => {
    const schemes = schemesIn(projectDir, container);
    const scheme = pickScheme(schemes, container, process.env);
    if (!scheme) {
      throw new Error(`cannot tell which scheme to test (shared schemes: ${schemes.join(', ') || 'none'}): set FIXCRASH_XCODE_SCHEME`);
    }
    return [container.flag, container.path, '-scheme', scheme];
  };
  const derivedData = (dirs: RunDirs) => join(dirs.cache, 'DerivedData');
  const commonArgs = (dirs: RunDirs): string[] => {
    const env = xcodeEnv();
    const scheme = schemeArgs();
    if (!destination) {
      const udid = env.FIXCRASH_XCODE_DESTINATION ? undefined : pickSimulator(xcrun(['simctl', 'list', 'devices', 'available', '--json'], env));
      destination = env.FIXCRASH_XCODE_DESTINATION ?? (udid ? `id=${udid}` : undefined);
      if (!destination) {
        throw new Error('no iPhone simulator: install an iOS runtime (xcodebuild -downloadPlatform iOS), or set FIXCRASH_XCODE_DESTINATION');
      }
    }
    return [...scheme, '-destination', destination, '-derivedDataPath', derivedData(dirs)];
  };
  const releaseProducts = (dirs: RunDirs, site: CrashSite) =>
    join(derivedData(dirs), 'Build', 'Products', site.simulator ? 'Release-iphonesimulator' : 'Release-iphoneos');
  const testRun = (args: string[], out: string, name: string) =>
    ['xcodebuild', 'test-without-building', ...args, '-parallel-testing-enabled', 'NO', '-resultBundlePath', join(out, name)];

  return {
    name: 'xcodebuild',

    isTestFile: (path) => TEST_FILE.test(path),

    locateTest(testId, testFiles) {
      // `Class.method`, `Suite.function()` or `Class`; one test class per file, named after it.
      const dot = testId.lastIndexOf('.');
      const classes = dot < 0 ? [testId] : [testId.slice(0, dot), testId];
      for (const cls of classes) {
        const file = testFiles.find((f) => TEST_FILE.test(f) && (f === `${cls}.swift` || f.endsWith(`/${cls}.swift`)));
        if (file) return file;
      }
      return undefined;
    },

    targetSteps(testId, testFile, dirs): Step[] {
      const target = testTargetOf(testFile, testTargets());
      if (!target) throw new Error(`cannot tell the test target of ${testFile}: put it in the test target's folder (named *Tests)`);
      const args = commonArgs(dirs);
      const only = `-only-testing:${target}/${onlyTestingPath(testId)}`;
      return [
        { command: ['xcodebuild', 'build-for-testing', ...args] },
        {
          command: [...testRun(args, dirs.out, 'tests.xcresult'), only],
          timeoutMs: TARGET_TEST_TIMEOUT_MS,
          retry: [...testRun(args, dirs.out, 'tests-retry.xcresult'), only],
        },
      ];
    },

    suiteSteps(dirs): Step[] {
      const args = commonArgs(dirs);
      const skipUi = testTargets().uiTests.map((t) => `-skip-testing:${t}`);
      return [
        { command: ['xcodebuild', 'build-for-testing', ...args] },
        { command: [...testRun(args, dirs.out, 'tests.xcresult'), ...skipUi] },
      ];
    },

    clean() {
      // Results go to the run's own directory, never into the project.
    },

    results: (_project, dirs) => readResults(dirs.out, xcodeEnv()),

    releaseSteps(dirs, site): Step[] {
      // The arm64 slice is enough: the crash came from it. A device build needs no signing to be symbolicated.
      return [{
        command: [
          'xcodebuild', 'build', ...schemeArgs(), '-configuration', 'Release',
          '-destination', site.simulator ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS',
          '-derivedDataPath', derivedData(dirs), 'ARCHS=arm64', 'DEBUG_INFORMATION_FORMAT=dwarf-with-dsym',
          ...(site.simulator ? [] : ['CODE_SIGNING_ALLOWED=NO']),
        ],
      }];
    },

    inlineFrames(dirs, site) {
      const products = releaseProducts(dirs, site);
      const dsym = [`${site.image}.app.dSYM`, `${site.image}.framework.dSYM`].map((n) => join(products, n)).find((p) => existsSync(p));
      if (!dsym) throw new Error(`no debug symbols for ${site.image} in the release build (${products})`);
      const dwarf = join(dsym, 'Contents', 'Resources', 'DWARF', site.image);
      return parseAtos(xcrun(['atos', '-arch', 'arm64', '-o', dwarf, '--offset', '-i', `0x${site.address.toString(16)}`], xcodeEnv()));
    },

    testImages(testFiles) {
      // A test target's binary is named after it.
      const names = testFiles.map((f) => testTargetOf(f, testTargets())).filter((t): t is string => t !== undefined);
      return new Set(names);
    },

    localFiles: ['GoogleService-Info.plist'],

    environment(env) {
      const dir = developerDir(env);
      return dir ? { env: { DEVELOPER_DIR: dir }, note: `xcode-select points at the Command Line Tools: using ${dir}` } : undefined;
    },

    hint(output) {
      if (/requires Xcode|active developer directory .* is a command line tools instance/.test(output)) {
        return 'xcodebuild needs Xcode: install it, then sudo xcode-select -s /Applications/Xcode.app';
      }
      if (/Unable to find a (device|destination) matching/.test(output)) {
        return 'no simulator for the destination: set FIXCRASH_XCODE_DESTINATION (e.g. "platform=iOS Simulator,name=iPhone 17"), or install an iOS runtime (xcodebuild -downloadPlatform iOS)';
      }
      if (/Could not resolve package dependencies|Failed to clone repository|unable to access 'https:/.test(output)) {
        return 'Swift packages could not be fetched: the first run resolves them, which needs the network';
      }
      if (/GoogleService-Info\.plist/.test(output) && /error/i.test(output)) {
        return 'The build needs GoogleService-Info.plist, which git ignores: verify copies it from your checkout, so put it there first.';
      }
      if (/requires a development team|No signing certificate/.test(output)) {
        return 'the build wants to sign for a device: tests run on a simulator, so check the scheme\'s test destination and the target\'s signing settings';
      }
      return undefined;
    },
  };
}
