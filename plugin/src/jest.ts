// React Native apps: Jest tests, run by reproduce and verify in fixcrash's
// worktree, and the crashing commit's bundle, built to symbolicate a JS
// error's frames (ADR-0004). node_modules come from npm's cache (ADR-0005).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestCase, TestStatus } from './junit.ts';
import type { RunDirs, Runner, Step } from './runner.ts';
import type { Frame, JsPosition, JsSite, Throwable } from './stack.ts';

/** Run as a step: installs node_modules, builds a bundle (`src/rnbuild.ts`). */
const RNBUILD = fileURLToPath(new URL('./rnbuild.ts', import.meta.url));
const JEST_BIN = 'node_modules/jest/bin/jest.js';
const RESULTS = 'jest.json';

const JEST_CONFIGS = ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'];

/** A JS project whose tests run with Jest: a package.json that names it, or a Jest config. */
export function isJestProject(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  if (JEST_CONFIGS.some((c) => existsSync(join(dir, c)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      jest?: unknown;
    };
    return Boolean(pkg.jest || pkg.devDependencies?.jest || pkg.dependencies?.jest || /\bjest\b/.test(pkg.scripts?.test ?? ''));
  } catch {
    return false;
  }
}

// Jest's default testMatch: files in __tests__, and *.test.* / *.spec.* files.
const TEST_FILE = /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;

/** `<file>::<full name>` or `<file>`: the test file and, if given, the test's full name. */
export function splitTestId(testId: string): { file: string; name?: string } {
  const i = testId.indexOf('::');
  return i < 0 ? { file: testId } : { file: testId.slice(0, i), name: testId.slice(i + 2) };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function jestStep(dirs: RunDirs, args: string[]): Step {
  return {
    command: [
      'node', JEST_BIN, '--ci', '--json', `--outputFile=${join(dirs.out, RESULTS)}`, '--no-watchman',
      `--cacheDirectory=${join(dirs.cache, 'jest-cache')}`, ...args,
    ],
  };
}

const depsStep: Step = { command: [process.execPath, RNBUILD, 'deps'] };

// --- Jest's results -----------------------------------------------------------

const V8_FRAME = /^at (?:async )?(?:(.*?) \((.*)\)|(.*))$/;
const LOCATION = /^(.*):(\d+):(\d+)$/;

/**
 * A failure message as Jest prints it: `Name: message`, then V8 frames mapped
 * through the source maps. Frame names are what the source map has at the
 * position (`url` in `raw.avatar.url`), not always the function. Files under
 * `projectDir` become relative to it.
 */
export function parseV8Stack(text: string, projectDir: string): Throwable[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
  const headerLines = firstFrame < 0 ? lines : lines.slice(0, firstFrame);
  const header = headerLines.join('\n').trim();
  if (header === '' && firstFrame < 0) return [];
  const m = header.match(/^([A-Za-z_$][\w$]*)(?::\s?([\s\S]*))?$/);
  const throwable: Throwable = {
    type: m ? m[1]! : 'Error',
    message: m ? (m[2] ?? '') : header,
    frames: [],
    relation: 'top',
  };
  const root = projectDir.endsWith(sep) ? projectDir : `${projectDir}${sep}`;
  for (const raw of firstFrame < 0 ? [] : lines.slice(firstFrame)) {
    const f = raw.trim().match(V8_FRAME);
    if (!f) continue;
    const symbol = f[1] ?? '';
    const loc = (f[2] ?? f[3] ?? '').match(LOCATION);
    const frame: Frame = { symbol: symbol || '<anonymous>' };
    if (loc) {
      frame.file = loc[1]!.startsWith(root) ? loc[1]!.slice(root.length) : loc[1]!;
      frame.line = Number(loc[2]);
    }
    throwable.frames.push(frame);
  }
  return [throwable];
}

interface JestJson {
  testResults?: {
    name: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[];
  }[];
}

const STATUS: Record<string, TestStatus> = { passed: 'passed', failed: 'failed' };

/** Jest's `--json` output as test cases: the class is the test file, the name is the test's full name. */
export function parseJestJson(json: string, projectDir: string): TestCase[] {
  const data = JSON.parse(json) as JestJson;
  const cases: TestCase[] = [];
  for (const file of data.testResults ?? []) {
    const classname = relative(projectDir, file.name).split(sep).join('/');
    const results = file.assertionResults ?? [];
    if (results.length === 0 && file.status === 'failed') {
      // The file didn't load: a syntax error, or an import the commit doesn't have.
      const text = file.message ?? '';
      cases.push({ classname, name: '(the test file failed to run)', status: 'failed', failure: { type: 'Error', message: text.slice(0, 300), text, chain: parseV8Stack(text, projectDir) } });
      continue;
    }
    for (const a of results) {
      const status = STATUS[a.status] ?? 'skipped';
      const c: TestCase = { classname, name: a.fullName, status };
      if (status === 'failed') {
        const text = (a.failureMessages ?? []).join('\n');
        const chain = parseV8Stack(a.failureMessages?.[0] ?? '', projectDir);
        c.failure = { type: chain[0]?.type ?? 'Error', message: chain[0]?.message ?? '', text, chain };
      }
      cases.push(c);
    }
  }
  return cases;
}

export const jest: Runner = {
  name: 'jest',

  isTestFile: (path) => !/(^|\/)node_modules\//.test(path) && TEST_FILE.test(path),

  testId: (id) => id.trim(),

  locateTest(testId, testFiles) {
    const { file } = splitTestId(testId);
    return testFiles.find((f) => f === file);
  },

  targetSteps(testId, testFile, dirs) {
    const { name } = splitTestId(testId);
    const select = name === undefined ? [] : ['--testNamePattern', `^${escapeRegExp(name)}$`];
    return [depsStep, jestStep(dirs, ['--runTestsByPath', testFile, ...select])];
  },

  suiteSteps: (dirs) => [depsStep, jestStep(dirs, [])],

  clean() {
    // Results go to the run's own directory.
  },

  results(projectDir, dirs) {
    const path = join(dirs.out, RESULTS);
    if (!existsSync(path)) return [];
    try {
      return parseJestJson(readFileSync(path, 'utf8'), projectDir);
    } catch (e) {
      throw new Error(`cannot read Jest's results ${path}: ${(e as Error).message}`);
    }
  },

  caseName: (c) => `${c.classname}::${c.name}`,

  localFiles: [],

  environment: () => undefined,

  hint(output) {
    if (/ENOTCACHED|only-if-cached/.test(output)) {
      return "npm ran with --offline and a package is missing from npm's cache. Run `npm ci` once in your checkout, which fills the cache, then try again.";
    }
    if (/yarn\.lock|pnpm-lock\.yaml/.test(output) && /only npm/.test(output)) {
      return 'fixcrash installs node_modules with npm only, for now (ADR-0005).';
    }
    if (/Cannot find module '.*jest/.test(output)) return "Jest isn't in the app's node_modules at this commit.";
    if (/hermesc/.test(output) && /not found|ENOENT/.test(output)) return 'No Hermes compiler in node_modules: fixcrash symbolicates Hermes bundles only.';
    return undefined;
  },
};

// --- Symbolication (ADR-0004) -------------------------------------------------

/** The steps that build the crashing commit's bundle, Hermes bytecode and composed source map into `out`. */
export function bundleSteps(platform: JsSite['platform'], out: string): Step[] {
  return [depsStep, { command: [process.execPath, RNBUILD, 'bundle', platform, out] }];
}

/** The composed source map `bundleSteps` writes. */
export const bundleMap = (out: string): string => join(out, 'bundle.map');

export interface SymbolicatedFrame {
  fn: string;
  /** Relative to the project directory, unless outside it. */
  file?: string;
  line?: number;
}

/** Reads `metro-symbolicate`'s output for `fn@line:column` lines: `<file>:<line>:<function>`, one per input line. */
export function parseSymbolicated(output: string, frames: JsPosition[], projectDir: string): SymbolicatedFrame[] {
  const root = projectDir.endsWith(sep) ? projectDir : `${projectDir}${sep}`;
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  return frames.map((p, i) => {
    const m = (lines[i] ?? '').match(/^(.+):(\d+):(.*)$/);
    if (!m || m[1] === 'null') return { fn: p.fn };
    const file = m[1]!.startsWith(root) ? m[1]!.slice(root.length) : m[1]!;
    return { fn: m[3] || p.fn, file, line: Number(m[2]) };
  });
}

/** Runs the app's own `metro-symbolicate` on the event's frames. Throws when it can't. */
export function symbolicate(projectDir: string, map: string, frames: JsPosition[], env: NodeJS.ProcessEnv): SymbolicatedFrame[] {
  const tool = 'node_modules/metro-symbolicate/src/index.js';
  if (!existsSync(join(projectDir, tool))) throw new Error(`no metro-symbolicate in ${projectDir}/node_modules`);
  // metro-symbolicate stops at line 0; built-ins are already left out of the frames.
  const input = frames.map((p) => `${p.fn}@${Math.max(p.line, 1)}:${p.column}`).join('\n');
  const r = spawnSync('node', [tool, map], { cwd: projectDir, env, input: `${input}\n`, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`metro-symbolicate failed: ${(r.stderr || r.stdout || String(r.error)).trim().slice(0, 300)}`);
  return parseSymbolicated(r.stdout, frames, projectDir);
}
