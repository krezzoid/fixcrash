// `fixcrash reproduce`: runs the test being written, still uncommitted in the
// working tree, at the crashing version in fixcrash's worktree, and says
// whether it fails as the crash did. Attempts and hypotheses are counted here,
// so the budget holds in code: past it, the answer is a report, not a guess.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as g from './git.ts';
import { resolveExpectation, type ExpectationSource } from './record.ts';
import { stateDir, type RunRecord } from './receipt.ts';
import type { Runner } from './runner.ts';
import { checkFails, lock, openProject, reportRun, resolveRef, runContext, short, VerifyError } from './run.ts';
import type { Expected } from './stack.ts';

export interface ReproduceOptions {
  cwd: string;
  issue: string;
  test: string;
  /** The crashing version's commit. */
  base: string;
  /** What this attempt tries, in a few words. */
  hypothesis: string;
  maxAttempts: number;
  maxHypotheses: number;
  /** Budgets are per issue and per run, e.g. a Claude Code session. */
  run?: string;
  expected?: Expected;
  projectDir?: string;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface Attempt {
  hypothesis: string;
  test: string;
  reproduced: boolean;
  reason: string;
  at: string;
}

export interface AttemptLog {
  issue: string;
  run: string;
  attempts: Attempt[];
}

export type ReproduceStatus = 'reproduced' | 'not-reproduced' | 'budget-spent';

export interface ReproduceResult {
  status: ReproduceStatus;
  reason: string;
  expectedSource?: ExpectationSource;
  record?: RunRecord;
  log: AttemptLog;
}

const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

function attemptsPath(common: string, issue: string, run: string): string {
  if (!SAFE.test(issue) || !SAFE.test(run)) throw new VerifyError(`issue and run ids may hold letters, digits, - and _ only`);
  return join(stateDir(common), 'attempts', `${issue}--${run}.json`);
}

function readAttempts(path: string, issue: string, run: string): AttemptLog {
  if (!existsSync(path)) return { issue, run, attempts: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as AttemptLog;
}

function writeAttempts(path: string, value: AttemptLog): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Test files changed or added in the working tree, relative to the repository root. */
function workingTestFiles(root: string, isTest: (repoPath: string) => boolean): string[] {
  const out = g.gitRaw(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const status = e.slice(0, 2);
    const path = e.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // the next entry is the old path
    if (status.includes('D')) continue;
    if (isTest(path)) files.push(path);
  }
  return files;
}

export function reproduce(opts: ReproduceOptions): ReproduceResult {
  const log = opts.log ?? (() => {});
  const project = openProject(opts.cwd, opts.projectDir, opts.runner);
  const { root, common, runner } = project;
  const run = opts.run ?? 'default';
  const path = attemptsPath(common, opts.issue, run);
  const history = readAttempts(path, opts.issue, run);

  let resolved;
  try {
    resolved = resolveExpectation(common, opts.issue, opts.expected);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }
  const base = resolveRef(project, opts.base);

  const testFiles = workingTestFiles(root, (p) => {
    const rel = project.toProject(p);
    return rel !== undefined && runner.isTestFile(rel);
  });
  if (testFiles.length === 0) throw new VerifyError('no new or changed test files in the working tree: write the test first');
  const targetFile = runner.locateTest(opts.test, testFiles.map((f) => project.toProject(f)!));
  if (!targetFile) {
    throw new VerifyError(`${opts.test} is not in the changed test files (${testFiles.join(', ')})`);
  }

  const hypotheses = [...new Set(history.attempts.map((a) => a.hypothesis))];
  const budget = `attempt ${history.attempts.length + 1} of ${opts.maxAttempts}`;
  const spent = (reason: string): ReproduceResult => {
    log(`BUDGET SPENT: ${reason}. Stop and report: the hypotheses tried, the evidence, and the data that is missing.`);
    for (const a of history.attempts) log(`- ${a.hypothesis}: ${a.reproduced ? 'reproduced' : a.reason}`);
    return { status: 'budget-spent', reason, log: history };
  };
  if (history.attempts.length >= opts.maxAttempts) return spent(`${history.attempts.length} of ${opts.maxAttempts} test attempts used`);
  if (!hypotheses.includes(opts.hypothesis) && hypotheses.length >= opts.maxHypotheses) {
    return spent(`${hypotheses.length} of ${opts.maxHypotheses} hypotheses used; a new one is over budget`);
  }

  const ctx = runContext(project, {
    logPrefix: `repro-${opts.issue.slice(0, 12)}-${history.attempts.length + 1}`,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    test: opts.test,
    targetFile,
    overlay: testFiles.map((p) => ({ path: p, content: readFileSync(join(root, p)) })),
    expected: resolved.expected,
  });

  if (project.envNote) log(`note: ${project.envNote}`);
  log(`fixcrash reproduce: issue ${opts.issue}, test ${opts.test}, ${budget}`);
  log(`hypothesis: ${opts.hypothesis}`);
  log(`expect ${resolved.expected.exception} at ${resolved.expected.frame} (${resolved.source === 'event' ? 'from the recorded Crashlytics event' : 'from the arguments'})`);

  // The attempt counts before it runs: a run that dies still used the budget.
  const attempt: Attempt = { hypothesis: opts.hypothesis, test: opts.test, reproduced: false, reason: 'did not finish', at: new Date().toISOString() };
  history.attempts.push(attempt);
  writeAttempts(path, history);

  const unlock = lock(project);
  let record: RunRecord;
  try {
    record = checkFails(ctx, 'base', base);
  } finally {
    unlock();
  }
  attempt.reproduced = record.ok;
  attempt.reason = record.reason;
  writeAttempts(path, history);

  reportRun(log, 'crashing version', record);
  const left = opts.maxAttempts - history.attempts.length;
  if (record.ok) {
    log(`REPRODUCED at ${short(base)}: ${record.reason}`);
    return { status: 'reproduced', reason: record.reason, expectedSource: resolved.source, record, log: history };
  }
  log(`NOT REPRODUCED: ${record.reason}. ${left} attempt${left === 1 ? '' : 's'} left`);
  return { status: 'not-reproduced', reason: record.reason, expectedSource: resolved.source, record, log: history };
}
