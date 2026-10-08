// The engine under `verify` and `reproduce`: runs a test command at a commit
// in fixcrash's own worktree (.git/fixcrash/worktree), reads the JUnit
// reports, and checks failures against the crash.

import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import * as g from './git.ts';
import { parseJUnit, selectCases, type TestCase } from './junit.ts';
import { stateDir, type RunRecord, type TargetResult } from './receipt.ts';
import { detectRunner, findFiles, type Runner } from './runner.ts';
import { formatFrame, matchFailure, parseJvmStack, testFrameDetector, type Expected } from './stack.ts';

/** A problem with the inputs or the environment, not with the code under test: exit code 2. */
export class VerifyError extends Error {}

export const short = (sha: string) => sha.slice(0, 12);

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
    throw new VerifyError(`no supported build tool in ${projectDir || '.'} (looked for: gradlew). Pass --project-dir if the app is in a subdirectory`);
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
  exitCode: number | null;
  durationMs: number;
  log: string;
  cases: TestCase[];
}

/** Checks out `commit` in the worktree, writes the overlay if asked, runs `command`, reads the reports. */
function runAt(ctx: RunContext, role: RunRecord['role'], commit: string, withOverlay: boolean, command: string[]): CommandResult {
  const { root, projectDir, runner, env } = ctx.project;
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

  // Untracked config the build needs: local.properties, google-services.json.
  const tracked = new Set(g.trackedFiles(ctx.worktree));
  const checkoutProject = join(root, projectDir);
  for (const f of findFiles(checkoutProject, new Set(runner.localFiles))) {
    const repoPath = join(projectDir, f);
    if (tracked.has(repoPath)) continue;
    mkdirSync(dirname(join(ctx.worktree, repoPath)), { recursive: true });
    copyFileSync(join(checkoutProject, f), join(ctx.worktree, repoPath));
  }

  // Stale reports from an earlier run would be read as this run's results.
  for (const r of runner.reportFiles(project)) unlinkSync(r);

  const log = join(ctx.logs, `${ctx.logPrefix}-${role}.log`);
  mkdirSync(ctx.logs, { recursive: true });
  const fd = openSync(log, 'w');
  const started = Date.now();
  let exitCode: number | null;
  try {
    writeFileSync(fd, `$ ${command.join(' ')}\n# at ${commit}, in ${project}\n\n`);
    const r = spawnSync(command[0]!, command.slice(1), {
      cwd: project,
      env,
      stdio: ['ignore', fd, fd],
      timeout: ctx.timeoutMs,
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
      throw new VerifyError(`cannot run ${command[0]}: ${r.error.message}`);
    }
    exitCode = r.status;
    if (r.signal) writeFileSync(fd, `\n# killed by ${r.signal}${r.error ? ' (timeout)' : ''}\n`);
  } finally {
    closeSync(fd);
  }
  const durationMs = Date.now() - started;

  const cases: TestCase[] = [];
  for (const r of runner.reportFiles(project)) {
    try {
      cases.push(...parseJUnit(readFileSync(r, 'utf8')));
    } catch (e) {
      throw new VerifyError(`cannot read test report ${r}: ${(e as Error).message}`);
    }
  }
  return { exitCode, durationMs, log, cases };
}

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
  const command = runner.targetCommand(ctx.test, ctx.targetFile);
  const r = runAt(ctx, role, commit, true, command);
  const where = `at ${short(commit)}`;
  const record: RunRecord = {
    role, commit, command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
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
  const isTestFrame = testFrameDetector(testPaths);

  for (const c of selected) {
    const name = `${c.classname}.${c.name}`;
    if (c.status !== 'failed' || !c.failure) {
      record.target.push({ name, status: c.status });
      record.reason = `${name} ${c.status} ${where}: it must fail there, as the crash did`;
      return record;
    }
    const chain = parseJvmStack(c.failure.text);
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
  const command = runner.suiteCommand();
  const r = runAt(ctx, 'head', commit, false, command);
  const tests = counts(r.cases);
  const record: RunRecord = {
    role: 'head', commit, command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
    tests, target: [], ok: false, reason: '',
  };
  const selected = selectCases(r.cases, ctx.test);
  record.target = selected.map((c): TargetResult => ({ name: `${c.classname}.${c.name}`, status: c.status }));
  const failed = r.cases.filter((c) => c.status === 'failed');

  if (selected.length === 0) {
    record.reason = notRunReason(ctx, r, 'with the fix');
  } else if (selected.some((c) => c.status !== 'passed')) {
    const bad = selected.find((c) => c.status !== 'passed')!;
    const detail = bad.failure ? `: ${parseJvmStack(bad.failure.text)[0]?.type ?? bad.failure.type}` : '';
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
