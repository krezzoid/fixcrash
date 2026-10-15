// `fixcrash verify`: decides whether a fix is proven, and writes a receipt
// only if it is. All runs happen in a worktree that fixcrash owns, from
// committed content, so the user's checkout is never touched.
//
//   base: the crashing version + the new test   -> the test fails as the crash did
//   from: the commit the fix starts from + test -> the test still fails that way
//   head: the fix                               -> the test passes, the suite is green

import { readFileSync, rmSync } from 'node:fs';
import { relative } from 'node:path';
import * as g from './git.ts';
import { resolveExpectation } from './record.ts';
import { RECEIPT_SCHEMA, receiptPath, writeReceipt, type Receipt, type RunRecord } from './receipt.ts';
import type { Runner } from './runner.ts';
import {
  checkFails, checkPasses, lock, openProject, reportRun, resolveRef, resolveSite, runContext, short, VerifyError,
} from './run.ts';
import { findShortcuts, shortcutReason } from './shortcut.ts';
import type { Expected } from './stack.ts';

export { VerifyError } from './run.ts';

export interface VerifyOptions {
  cwd: string;
  issue: string;
  /** `Class.method` (or `Class`), as the test runner names it. */
  test: string;
  /** Default: the failure recorded from the issue's Crashlytics event. */
  expected?: Expected;
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

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export function verify(opts: VerifyOptions): VerifyResult {
  const log = opts.log ?? (() => {});
  const project = openProject(opts.cwd, opts.projectDir, opts.runner);
  const { root, common, runner } = project;

  const test = runner.testId?.(opts.test) ?? opts.test;
  const dirty = g.dirtyFiles(root);
  if (dirty.length > 0) {
    throw new VerifyError(`uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}): verify proves a commit, so commit the test and the fix first`);
  }

  let resolved;
  try {
    resolved = resolveExpectation(common, opts.issue, opts.expected);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }
  const { expected, source: expectedSource } = resolved;

  const head = resolveRef(project, 'HEAD');
  const base = resolveRef(project, opts.base);
  let from: string;
  if (opts.from) {
    from = resolveRef(project, opts.from);
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

  const changes = g.changedFiles(root, from, head);
  const testFiles = changes
    .filter((c) => {
      const p = project.toProject(c.path);
      return c.status !== 'D' && p !== undefined && runner.isTestFile(p);
    })
    .map((c) => c.path);
  const fixFiles = changes.map((c) => c.path).filter((p) => !testFiles.includes(p));
  if (testFiles.length === 0) throw new VerifyError(`no test files changed between ${short(from)} and HEAD`);
  if (fixFiles.length === 0) throw new VerifyError(`only test files changed between ${short(from)} and HEAD: there is no fix`);

  const projectTestFiles = testFiles.map((f) => project.toProject(f)!);
  const targetFile = runner.locateTest(test, projectTestFiles);
  if (!targetFile) {
    throw new VerifyError(`${test} is not in the test files changed by the fix (${projectTestFiles.join(', ')}): the test must be new or changed`);
  }

  const ctx = runContext(project, {
    logPrefix: short(head),
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    test,
    targetFile,
    overlay: testFiles.map((path) => ({ path, content: g.showFile(root, head, path) })),
    expected,
  });

  if (project.envNote) log(`note: ${project.envNote}`);
  log(`fixcrash verify: issue ${opts.issue}, test ${test}`);
  log(`expect ${expected.exception} at ${expected.frame} (${expectedSource === 'event' ? 'from the recorded Crashlytics event' : 'from the arguments'})`);
  const runs: RunRecord[] = [];
  const done = (reason: string): VerifyResult => {
    log(`NOT VERIFIED: ${reason}`);
    return { verified: false, reason, runs };
  };

  const unlock = lock(project);
  try {
    // The latest verify of a commit decides: a failed one leaves no receipt behind.
    rmSync(receiptPath(common, head), { force: true });

    const shortcuts = testFiles.flatMap((p) => findShortcuts(p, g.showFile(root, head, p).toString('utf8'), g.addedLines(root, from, head, p)));
    if (shortcuts.length > 0) return done(shortcutReason(shortcuts));

    const site = resolveSite(ctx, base);
    if (site.note) {
      log(`crash site: ${site.note}`);
      ctx.expected = site.expected;
      log(`expect ${ctx.expected.exception} at ${ctx.expected.frame}`);
    }

    const b = checkFails(ctx, 'base', base);
    runs.push(b);
    reportRun(log, 'base (crashing version)', b);
    if (!b.ok) return done(b.reason);

    if (from !== base) {
      const f = checkFails(ctx, 'from', from);
      runs.push(f);
      reportRun(log, 'from (fix parent)', f);
      if (!f.ok) {
        const already = f.target.some((t) => t.status === 'passed');
        return done(already ? `${f.reason}. The crash may already be fixed at ${short(from)}` : f.reason);
      }
    } else {
      log(`from ${short(from)}: same commit as base, not run again`);
    }

    const h = checkPasses(ctx, head);
    runs.push(h);
    reportRun(log, 'head (fix)', h);
    if (!h.ok) return done(h.reason);

    const receipt: Receipt = {
      schema: RECEIPT_SCHEMA,
      verified: true,
      head, base, from,
      issue: opts.issue,
      test,
      expected: ctx.expected,
      expectedSource,
      ...(site.note ? { crashSite: site.chain ? { chain: site.chain, note: site.note } : { note: site.note } } : {}),
      projectDir: project.projectDir,
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
