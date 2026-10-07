// `fixcrash verify`: decides whether a fix is proven, and writes a receipt
// only if it is. All runs happen in a worktree that fixcrash owns, from
// committed content, so the user's checkout is never touched.
//
//   base: the crashing version + the new test   -> the test fails as the crash did
//   from: the commit the fix starts from + test -> the test still fails that way
//   head: the fix                               -> the test passes, the suite is green

import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import * as g from './git.ts';
import { parseJUnit, selectCases, type TestCase } from './junit.ts';
import { receiptPath, stateDir, writeReceipt, type Receipt, type RunRecord, type TargetResult } from './receipt.ts';
import { detectRunner, findFiles, type Runner } from './runner.ts';
import { formatFrame, matchFailure, parseJvmStack, testFrameDetector, type Expected } from './stack.ts';

/** A problem with the inputs or the environment, not with the fix: exit code 2. */
export class VerifyError extends Error {}

export interface VerifyOptions {
  cwd: string;
  issue: string;
  /** `Class.method` (or `Class`), as the test runner names it. */
  test: string;
  expected: Expected;
  /** The crashing version's commit. */
  base: string;
  /** The commit the fix starts from; default: merge-base of HEAD and the default branch. */
  from?: string;
  /** The build tool's directory, relative to `cwd`; default: `cwd`. */
  projectDir?: string;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface VerifyResult {
  verified: boolean;
  reason: string;
  runs: RunRecord[];
  receipt?: Receipt;
  receiptPath?: string;
}

const short = (sha: string) => sha.slice(0, 12);

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

/** One verify at a time per repository: they share the worktree. */
function lock(dir: string): () => void {
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
      throw new VerifyError(`another fixcrash verify${pid > 0 ? ` (pid ${pid})` : ''} holds ${path}; remove it if none is running`);
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

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

interface Context {
  root: string;
  head: string;
  projectDir: string;
  runner: Runner;
  worktree: string;
  logs: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** A repository path relative to the project directory, or undefined if outside it. */
  toProject: (repoPath: string) => string | undefined;
  /** Test files changed by the fix, relative to the repository root. */
  testFiles: string[];
  /** The target test's file, relative to the project directory. */
  targetFile: string;
  opts: VerifyOptions;
}

interface CommandResult {
  exitCode: number | null;
  durationMs: number;
  log: string;
  cases: TestCase[];
}

/** Checks out `commit` in the worktree, overlays the test files if asked, runs `command`, reads reports. */
function runAt(ctx: Context, role: RunRecord['role'], commit: string, overlay: boolean, command: string[]): CommandResult {
  g.prepareWorktree(ctx.root, ctx.worktree, commit);
  const project = join(ctx.worktree, ctx.projectDir);
  if (!existsSync(project)) throw new VerifyError(`${ctx.projectDir || '.'} does not exist at ${short(commit)}`);

  if (overlay) {
    for (const f of ctx.testFiles) {
      const dest = join(ctx.worktree, f);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, g.showFile(ctx.root, ctx.head, f));
    }
  }

  // Untracked config the build needs: local.properties, google-services.json.
  const tracked = new Set(g.trackedFiles(ctx.worktree));
  const checkoutProject = join(ctx.root, ctx.projectDir);
  for (const f of findFiles(checkoutProject, new Set(ctx.runner.localFiles))) {
    const repoPath = join(ctx.projectDir, f);
    if (tracked.has(repoPath)) continue;
    mkdirSync(dirname(join(ctx.worktree, repoPath)), { recursive: true });
    copyFileSync(join(checkoutProject, f), join(ctx.worktree, repoPath));
  }

  // Stale reports from an earlier run would be read as this run's results.
  for (const r of ctx.runner.reportFiles(project)) unlinkSync(r);

  const log = join(ctx.logs, `${short(ctx.head)}-${role}.log`);
  mkdirSync(ctx.logs, { recursive: true });
  const fd = openSync(log, 'w');
  const started = Date.now();
  let exitCode: number | null;
  try {
    writeFileSync(fd, `$ ${command.join(' ')}\n# at ${commit}, in ${project}\n\n`);
    const r = spawnSync(command[0]!, command.slice(1), {
      cwd: project,
      env: ctx.env,
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
  for (const r of ctx.runner.reportFiles(project)) {
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

function notRunReason(ctx: Context, r: CommandResult, where: string): string {
  const hint = ctx.runner.hint(tail(r.log, 200));
  const build = r.exitCode === null ? 'the command timed out or was killed' : `the command exited with ${r.exitCode}`;
  return `${ctx.opts.test} did not run ${where} (${build}; does it compile there?)${hint ? `. ${hint}` : ''}`;
}

/** base and from: the test must fail, every matching case, the way the crash did. */
function checkFails(ctx: Context, role: 'base' | 'from', commit: string): RunRecord {
  const command = ctx.runner.targetCommand(ctx.opts.test, ctx.targetFile);
  const r = runAt(ctx, role, commit, true, command);
  const where = `at ${short(commit)}`;
  const record: RunRecord = {
    role, commit, command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
    tests: counts(r.cases), target: [], ok: false, reason: '',
  };
  const selected = selectCases(r.cases, ctx.opts.test);
  if (selected.length === 0) {
    record.reason = notRunReason(ctx, r, where);
    return record;
  }

  // Test code in the worktree at this commit, plus the overlaid test files.
  const testPaths = g.trackedFiles(ctx.worktree)
    .filter((f) => {
      const p = ctx.toProject(f);
      return p !== undefined && ctx.runner.isTestFile(p);
    })
    .concat(ctx.testFiles);
  const isTestFrame = testFrameDetector(testPaths);

  for (const c of selected) {
    const name = `${c.classname}.${c.name}`;
    if (c.status !== 'failed' || !c.failure) {
      record.target.push({ name, status: c.status });
      record.reason = `${name} ${c.status} ${where}: it must fail there, as the crash did`;
      return record;
    }
    const chain = parseJvmStack(c.failure.text);
    const m = matchFailure(chain, ctx.opts.expected, isTestFrame);
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

/** head: the full suite passes, the new test with it. */
function checkPasses(ctx: Context): RunRecord {
  const command = ctx.runner.suiteCommand();
  const r = runAt(ctx, 'head', ctx.head, false, command);
  const tests = counts(r.cases);
  const record: RunRecord = {
    role: 'head', commit: ctx.head, command, exitCode: r.exitCode, durationMs: r.durationMs, log: r.log,
    tests, target: [], ok: false, reason: '',
  };
  const selected = selectCases(r.cases, ctx.opts.test);
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
    const hint = ctx.runner.hint(tail(r.log, 200));
    record.reason = `the suite command exited with ${r.exitCode ?? 'a signal'} although no test failed${hint ? `. ${hint}` : ''}`;
  } else {
    record.ok = true;
    record.reason = `the test passes; suite green: ${tests.total} tests, ${tests.skipped} skipped`;
  }
  return record;
}

export function verify(opts: VerifyOptions): VerifyResult {
  const log = opts.log ?? (() => {});
  let root: string;
  try {
    root = g.repoRoot(opts.cwd);
  } catch {
    throw new VerifyError(`not in a git repository: ${opts.cwd}`);
  }
  const common = g.commonDir(opts.cwd);
  const projectAbs = resolvePath(opts.cwd, opts.projectDir ?? '.');
  if (!existsSync(projectAbs)) throw new VerifyError(`no such directory: ${projectAbs}`);
  let projectDir: string;
  try {
    projectDir = g.prefix(projectAbs);
    if (g.repoRoot(projectAbs) !== root) throw new Error();
  } catch {
    throw new VerifyError(`${projectAbs} is not in the repository at ${root}`);
  }

  const dirty = g.dirtyFiles(root);
  if (dirty.length > 0) {
    throw new VerifyError(`uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}): verify proves a commit, so commit the test and the fix first`);
  }

  const resolve = (ref: string) => {
    try {
      return g.resolveCommit(root, ref);
    } catch (e) {
      throw new VerifyError((e as Error).message);
    }
  };
  const head = resolve('HEAD');
  const base = resolve(opts.base);
  let from: string;
  if (opts.from) {
    from = resolve(opts.from);
  } else {
    const branch = g.defaultBranch(root);
    if (!branch) throw new VerifyError('cannot tell the default branch: pass --from <the commit the fix starts from>');
    from = g.mergeBase(root, head, branch);
    if (from === head) {
      throw new VerifyError(`HEAD is on ${branch} with no commits of its own: commit the test and the fix on a branch, or pass --from`);
    }
  }
  if (from === head) throw new VerifyError('--from is HEAD: there is no fix to verify');
  if (!g.isAncestor(root, from, head)) throw new VerifyError(`${short(from)} is not an ancestor of HEAD`);

  const runner = opts.runner ?? detectRunner(join(root, projectDir));
  if (!runner) {
    throw new VerifyError(`no supported build tool in ${projectDir || '.'} (looked for: gradlew). Pass --project-dir if the app is in a subdirectory`);
  }

  const toProject = (p: string) => {
    if (projectDir === '') return p;
    return p.startsWith(`${projectDir}/`) ? p.slice(projectDir.length + 1) : undefined;
  };
  const changes = g.changedFiles(root, from, head);
  const testFiles = changes
    .filter((c) => {
      const p = toProject(c.path);
      return c.status !== 'D' && p !== undefined && runner.isTestFile(p);
    })
    .map((c) => c.path);
  const fixFiles = changes.map((c) => c.path).filter((p) => !testFiles.includes(p));
  if (testFiles.length === 0) throw new VerifyError(`no test files changed between ${short(from)} and HEAD`);
  if (fixFiles.length === 0) throw new VerifyError(`only test files changed between ${short(from)} and HEAD: there is no fix`);

  const projectTestFiles = testFiles.map((f) => toProject(f)!);
  const targetProjectFile = runner.locateTest(opts.test, projectTestFiles);
  if (!targetProjectFile) {
    throw new VerifyError(`${opts.test} is not in the test files changed by the fix (${projectTestFiles.join(', ')}): the test must be new or changed`);
  }

  const env = { ...process.env };
  const extra = runner.environment(env);
  if (extra) {
    Object.assign(env, extra.env);
    log(`note: ${extra.note}`);
  }

  const state = stateDir(common);
  const ctx: Context = {
    root, head, projectDir, runner, env, toProject,
    worktree: join(state, 'worktree'),
    logs: join(state, 'logs'),
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    testFiles, targetFile: targetProjectFile, opts,
  };

  log(`fixcrash verify: issue ${opts.issue}, test ${opts.test}`);
  log(`expect ${opts.expected.exception} at ${opts.expected.frame}`);
  const runs: RunRecord[] = [];
  const done = (reason: string): VerifyResult => {
    log(`NOT VERIFIED: ${reason}`);
    return { verified: false, reason, runs };
  };
  const report = (label: string, r: RunRecord) => {
    log(`${label} ${short(r.commit)}: ${r.ok ? 'ok' : 'FAILED'}: ${r.reason} [${(r.durationMs / 1000).toFixed(1)} s]`);
    if (!r.ok) log(`log: ${r.log}${r.target.length === 0 ? `\n${tail(r.log, 25)}` : ''}`);
  };

  const unlock = lock(state);
  try {
    // The latest verify of a commit decides: a failed one leaves no receipt behind.
    rmSync(receiptPath(common, head), { force: true });

    const b = checkFails(ctx, 'base', base);
    runs.push(b);
    report('base (crashing version)', b);
    if (!b.ok) return done(b.reason);

    if (from !== base) {
      const f = checkFails(ctx, 'from', from);
      runs.push(f);
      report('from (fix parent)', f);
      if (!f.ok) {
        const already = f.target.some((t) => t.status === 'passed');
        return done(already ? `${f.reason}. The crash may already be fixed at ${short(from)}` : f.reason);
      }
    } else {
      log(`from ${short(from)}: same commit as base, not run again`);
    }

    const h = checkPasses(ctx);
    runs.push(h);
    report('head (fix)', h);
    if (!h.ok) return done(h.reason);

    const receipt: Receipt = {
      schema: 1,
      verified: true,
      head, base, from,
      issue: opts.issue,
      test: opts.test,
      expected: opts.expected,
      projectDir,
      runner: runner.name,
      testFiles,
      fixFiles,
      // Log paths relative to the git directory: the receipt feeds the PR body.
      runs: runs.map((r) => ({ ...r, log: relative(common, r.log) })),
      createdAt: new Date().toISOString(),
      fixcrash: packageVersion(),
    };
    const path = writeReceipt(common, receipt);
    log(`VERIFIED: receipt ${path}`);
    return { verified: true, reason: 'verified', runs, receipt, receiptPath: path };
  } finally {
    unlock();
  }
}
