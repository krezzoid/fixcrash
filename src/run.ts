// The engine under `verify` and `reproduce`: runs a test command at a commit
// in fixcrash's own worktree (.git/fixcrash/worktree), reads the test results
// (JUnit reports, Xcode result bundles), and checks failures against the crash.

import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import * as g from './git.ts';
import { selectCases, type TestCase, type TestFailure } from './junit.ts';
import { stateDir, type RunRecord, type TargetResult } from './receipt.ts';
import { findFiles, gradle, type RunDirs, type Runner, type Step } from './runner.ts';
import {
  formatFrame, matchFailure, parseJvmStack, sameSymbol, testFrameDetector, type Expected, type Frame, type Throwable,
} from './stack.ts';
import { findXcodeContainer, xcodebuild } from './xcode.ts';

/** A problem with the inputs or the environment, not with the code under test: exit code 2. */
export class VerifyError extends Error {}

export const short = (sha: string) => sha.slice(0, 12);

/** The runner for a project directory, or undefined when no supported build tool is found. */
export function detectRunner(projectDir: string): Runner | undefined {
  if (existsSync(join(projectDir, 'gradlew'))) return gradle;
  if (findXcodeContainer(projectDir)) return xcodebuild(projectDir);
  return undefined;
}

/** The repository, the build tool's directory in it, and how to run its tests. */
export interface Project {
  root: string;
  /** The shared git directory, where fixcrash keeps its state. */
  common: string;
  /** The build tool's directory, relative to the repository root ('' at the root). */
  projectDir: string;
  runner: Runner;
  env: NodeJS.ProcessEnv;
  /** Why the environment was extended, for the log. */
  envNote?: string;
  /** A repository path relative to the project directory, or undefined if outside it. */
  toProject: (repoPath: string) => string | undefined;
}

export function openProject(cwd: string, projectDirOption: string | undefined, runnerOption: Runner | undefined): Project {
  let root: string;
  try {
    root = g.repoRoot(cwd);
  } catch {
    throw new VerifyError(`not in a git repository: ${cwd}`);
  }
  const projectAbs = resolvePath(cwd, projectDirOption ?? '.');
  if (!existsSync(projectAbs)) throw new VerifyError(`no such directory: ${projectAbs}`);
  let projectDir: string;
  try {
    projectDir = g.prefix(projectAbs);
    if (g.repoRoot(projectAbs) !== root) throw new Error();
  } catch {
    throw new VerifyError(`${projectAbs} is not in the repository at ${root}`);
  }
  const runner = runnerOption ?? detectRunner(join(root, projectDir));
  if (!runner) {
    throw new VerifyError(`no supported build tool in ${projectDir || '.'} (looked for: gradlew, *.xcworkspace, *.xcodeproj). Pass --project-dir if the app is in a subdirectory`);
  }
  const env = { ...process.env };
  const extra = runner.environment(env);
  if (extra) Object.assign(env, extra.env);
  const toProject = (p: string) => {
    if (projectDir === '') return p;
    return p.startsWith(`${projectDir}/`) ? p.slice(projectDir.length + 1) : undefined;
  };
  return { root, common: g.commonDir(cwd), projectDir, runner, env, envNote: extra?.note, toProject };
}

export function resolveRef(project: Project, ref: string): string {
  try {
    return g.resolveCommit(project.root, ref);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }
}

/** A test file to write into the worktree before a run: path relative to the repository root. */
export interface OverlayFile {
  path: string;
  content: Buffer;
}

export interface RunContext {
  project: Project;
  worktree: string;
  logs: string;
  /** Log file names start with it. */
  logPrefix: string;
  timeoutMs: number;
  /** `Class.method` (or `Class`), as the test runner names it. */
  test: string;
  /** The target test's file, relative to the project directory. */
  targetFile: string;
  /** The new test files, written at the commits where the test must fail. */
  overlay: OverlayFile[];
  expected: Expected;
}

export function runContext(project: Project, fields: Omit<RunContext, 'project' | 'worktree' | 'logs'>): RunContext {
  const state = stateDir(project.common);
  return { project, worktree: join(state, 'worktree'), logs: join(state, 'logs'), ...fields };
}

/** One run at a time per repository: verify and reproduce share the worktree. */
export function lock(project: Project): () => void {
  const dir = stateDir(project.common);
  const path = join(dir, 'lock');
  const pidFile = join(path, 'pid');
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      writeFileSync(pidFile, String(process.pid));
      return () => rmSync(path, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : NaN);
    if (!(pid > 0) || isAlive(pid)) {
      throw new VerifyError(`another fixcrash run${pid > 0 ? ` (pid ${pid})` : ''} holds ${path}; remove it if none is running`);
    }
    rmSync(path, { recursive: true, force: true });
  }
  throw new VerifyError(`cannot take the lock ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

interface CommandResult {
  dirs: RunDirs;
  /** The last command that ran. */
  command: string[];
  exitCode: number | null;
  durationMs: number;
  log: string;
  cases: TestCase[];
}

/** Checks out `commit` in the worktree, writes the overlay if asked, runs the steps, reads the results. */
function runAt(
  ctx: RunContext, label: string, commit: string, withOverlay: boolean, stepsFor: (dirs: RunDirs) => Step[],
): CommandResult {
  const { root, common, projectDir, runner, env } = ctx.project;
  g.prepareWorktree(root, ctx.worktree, commit);
  const project = join(ctx.worktree, projectDir);
  if (!existsSync(project)) throw new VerifyError(`${projectDir || '.'} does not exist at ${short(commit)}`);

  if (withOverlay) {
    for (const f of ctx.overlay) {
      const dest = join(ctx.worktree, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
  }

  // Untracked config the build needs: local.properties, google-services.json, GoogleService-Info.plist.
  const tracked = new Set(g.trackedFiles(ctx.worktree));
  const checkoutProject = join(root, projectDir);
  for (const f of findFiles(checkoutProject, new Set(runner.localFiles))) {
    const repoPath = join(projectDir, f);
    if (tracked.has(repoPath)) continue;
    mkdirSync(dirname(join(ctx.worktree, repoPath)), { recursive: true });
    copyFileSync(join(checkoutProject, f), join(ctx.worktree, repoPath));
  }

  runner.clean(project);
  const dirs: RunDirs = {
    out: join(ctx.logs, `${ctx.logPrefix}-${label}`),
    cache: join(stateDir(common), 'cache', runner.name),
  };
  rmSync(dirs.out, { recursive: true, force: true });
  mkdirSync(dirs.out, { recursive: true });
  mkdirSync(dirs.cache, { recursive: true });
  let steps: Step[];
  try {
    steps = stepsFor(dirs);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }

  const log = join(ctx.logs, `${ctx.logPrefix}-${label}.log`);
  const fd = openSync(log, 'w');
  const started = Date.now();
  let exitCode: number | null = null;
  let command: string[] = [];
  try {
    writeFileSync(fd, `# at ${commit}, in ${project}\n`);
    const exec = (argv: string[], timeout: number): boolean => {
      command = argv;
      writeFileSync(fd, `\n$ ${argv.join(' ')}\n\n`);
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: project, env, stdio: ['ignore', fd, fd], timeout });
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      if (r.error && !timedOut) throw new VerifyError(`cannot run ${argv[0]}: ${r.error.message}`);
      exitCode = r.status;
      if (r.signal) writeFileSync(fd, `\n# killed by ${r.signal}${timedOut ? ` (timeout, ${Math.round(timeout / 1000)} s)` : ''}\n`);
      return timedOut;
    };
    for (const [i, step] of steps.entries()) {
      const timeout = step.timeoutMs ?? ctx.timeoutMs;
      if (exec(step.command, timeout) && step.retry) exec(step.retry, timeout);
      if (exitCode !== 0 && i < steps.length - 1) break;
    }
  } finally {
    closeSync(fd);
  }
  const durationMs = Date.now() - started;

  let cases: TestCase[];
  try {
    cases = runner.results(project, dirs);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }
  return { dirs, command, exitCode, durationMs, log, cases };
}

/** What `resolveSite` decided, for the log and the receipt. */
export interface SiteResolution {
  expected: Expected;
  /** The frames at the crash site in the release build, innermost first, when they were read. */
  chain?: string[];
  /** One line on what was found, or why the blame frame stands. */
  note: string;
}

/**
 * ADR-0002. On Apple platforms the blame frame is the caller of the function
 * that crashed when the optimizer inlined that function. Builds the crashing
 * commit as it ships, reads the frames at the crash site from the build's
 * debug symbols, and expects the innermost frame in the app's own sources, if
 * the frames end in the blame frame. Otherwise the blame frame stands.
 * Cached per commit and site.
 */
export function resolveSite(ctx: RunContext, base: string): SiteResolution {
  const { runner, common, projectDir } = ctx.project;
  const site = ctx.expected.site;
  if (!site || !runner.releaseSteps || !runner.inlineFrames) return { expected: ctx.expected, note: '' };
  const cache = join(stateDir(common), 'cache', runner.name, 'sites', `${base}-${site.image}-${site.address}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as SiteResolution;
  const stands = (why: string): SiteResolution => ({ expected: ctx.expected, note: `${why}: the blame frame ${ctx.expected.frame} stands` });
  const save = (r: SiteResolution): SiteResolution => {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, `${JSON.stringify(r, null, 2)}\n`);
    return r;
  };

  const r = runAt(ctx, 'release', base, false, (dirs) => runner.releaseSteps!(dirs, site));
  if (r.exitCode !== 0) return stands(`the release build of ${short(base)} failed (${r.log})`);
  let frames: Frame[];
  try {
    frames = runner.inlineFrames(r.dirs, site);
  } catch (e) {
    return stands((e as Error).message);
  }
  const chain = frames.map(formatFrame);
  const outer = frames.at(-1);
  if (!outer || !sameSymbol(outer.symbol, ctx.expected.frame)) {
    return save({ ...stands(`at the crash site, the release build has ${chain.join(' < ') || 'no frames'}, not the shipped code`), chain });
  }
  const project = join(ctx.worktree, projectDir);
  const ours = (f: Frame) => f.file !== undefined && findFiles(project, new Set([basename(f.file)])).length > 0;
  const crashed = frames.find(ours) ?? outer;
  const failure = frames.find((f) => f.symbol.startsWith('Swift runtime failure: '))?.symbol;
  const where = crashed === outer ? `in ${formatFrame(outer)} itself` : `in ${formatFrame(crashed)}, inlined into ${ctx.expected.frame}`;
  return save({
    expected: { ...ctx.expected, frame: crashed.symbol },
    chain,
    note: `the crash is ${where}${failure ? ` (${failure})` : ''}`,
  });
}

/** The failure as a chain of throwables: parsed by the runner (crash logs), or a JVM stack trace. */
const chainOf = (f: TestFailure): Throwable[] => f.chain ?? parseJvmStack(f.text);

function counts(cases: TestCase[]): RunRecord['tests'] {
  return {
    total: cases.length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
  };
}

function notRunReason(ctx: RunContext, r: CommandResult, where: string): string {
  const hint = ctx.project.runner.hint(tail(r.log, 200));
  const build = r.exitCode === null ? 'the command timed out or was killed' : `the command exited with ${r.exitCode}`;
  return `${ctx.test} did not run ${where} (${build}; does it compile there?)${hint ? `. ${hint}` : ''}`;
}

/** The test must fail at `commit`, every matching case, the way the crash did. */
export function checkFails(ctx: RunContext, role: 'base' | 'from', commit: string): RunRecord {
  const { runner, toProject } = ctx.project;
  const r = runAt(ctx, role, commit, true, (dirs) => runner.targetSteps(ctx.test, ctx.targetFile, dirs));
  const where = `at ${short(commit)}`;
  const record: RunRecord = {
    role, commit, command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
    tests: counts(r.cases), target: [], ok: false, reason: '',
  };
  const selected = selectCases(r.cases, ctx.test);
  if (selected.length === 0) {
    record.reason = notRunReason(ctx, r, where);
    return record;
  }

  // Test code in the worktree at this commit, plus the overlaid test files.
  const testPaths = g.trackedFiles(ctx.worktree)
    .filter((f) => {
      const p = toProject(f);
      return p !== undefined && runner.isTestFile(p);
    })
    .concat(ctx.overlay.map((f) => f.path));
  const byFile = testFrameDetector(testPaths);
  const images = runner.testImages?.(testPaths.map((p) => toProject(p)).filter((p): p is string => p !== undefined));
  const isTestFrame = (f: Frame) => (f.image !== undefined && images ? images.has(f.image) : byFile(f));

  for (const c of selected) {
    const name = `${c.classname}.${c.name}`;
    if (c.status !== 'failed' || !c.failure) {
      record.target.push({ name, status: c.status });
      record.reason = `${name} ${c.status} ${where}: it must fail there, as the crash did`;
      return record;
    }
    const chain = chainOf(c.failure);
    const m = matchFailure(chain, ctx.expected, isTestFrame);
    if (!m.ok) {
      const top = chain[0];
      record.target.push({
        name, status: c.status, exception: top?.type ?? c.failure.type, message: top?.message.slice(0, 300),
        top: top?.frames.slice(0, 5).map(formatFrame),
      });
      record.reason = `${name} fails ${where}, but not as the crash did: ${m.reason}`;
      return record;
    }
    record.target.push({
      name,
      status: c.status,
      exception: m.throwable.type,
      message: m.throwable.message.slice(0, 300),
      frame: formatFrame(m.throwable.frames[m.frameIndex]!),
      top: m.throwable.frames.slice(0, m.frameIndex + 1).slice(0, 8).map(formatFrame),
    });
  }
  const first = record.target[0]!;
  record.ok = true;
  record.reason = `fails as the crash did: ${first.exception} at ${first.frame}`;
  return record;
}

/** The full suite passes at `commit`, the new test with it. */
export function checkPasses(ctx: RunContext, commit: string): RunRecord {
  const { runner } = ctx.project;
  const r = runAt(ctx, 'head', commit, false, (dirs) => runner.suiteSteps(dirs));
  const tests = counts(r.cases);
  const record: RunRecord = {
    role: 'head', commit, command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
    tests, target: [], ok: false, reason: '',
  };
  const selected = selectCases(r.cases, ctx.test);
  record.target = selected.map((c): TargetResult => ({ name: `${c.classname}.${c.name}`, status: c.status }));
  const failed = r.cases.filter((c) => c.status === 'failed');

  if (selected.length === 0) {
    record.reason = notRunReason(ctx, r, 'with the fix');
  } else if (selected.some((c) => c.status !== 'passed')) {
    const bad = selected.find((c) => c.status !== 'passed')!;
    const detail = bad.failure ? `: ${chainOf(bad.failure)[0]?.type ?? bad.failure.type}` : '';
    record.reason = `${bad.classname}.${bad.name} ${bad.status} with the fix${detail}`;
  } else if (failed.length > 0) {
    const names = failed.slice(0, 5).map((c) => `${c.classname}.${c.name}`).join(', ');
    record.reason = `the suite is red with the fix: ${failed.length} failed (${names}${failed.length > 5 ? ', …' : ''})`;
  } else if (r.exitCode !== 0) {
    const hint = runner.hint(tail(r.log, 200));
    record.reason = `the suite command exited with ${r.exitCode ?? 'a signal'} although no test failed${hint ? `. ${hint}` : ''}`;
  } else {
    record.ok = true;
    record.reason = `the test passes; suite green: ${tests.total} tests, ${tests.skipped} skipped`;
  }
  return record;
}

/** One line per run for the console; the log tail when nothing ran. */
export function reportRun(log: (line: string) => void, label: string, r: RunRecord): void {
  log(`${label} ${short(r.commit)}: ${r.ok ? 'ok' : 'FAILED'}: ${r.reason} [${(r.durationMs / 1000).toFixed(1)} s]`);
  if (!r.ok) log(`log: ${r.log}${r.target.length === 0 ? `\n${tail(r.log, 25)}` : ''}`);
}
