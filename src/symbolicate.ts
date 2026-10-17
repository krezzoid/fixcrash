// `fixcrash symbolicate`: where a recorded JS error is in the app's sources at
// the crashing commit (ADR-0004). The same step reproduce and verify take
// before they run a test, on its own: the agent reads it before writing one.

import { resolveExpectation } from './record.ts';
import type { Runner } from './runner.ts';
import {
  checkRunnerFits, lock, openProject, resolveJsSite, resolveRef, runContext, short, VerifyError, type SiteResolution,
} from './run.ts';
import type { Expected } from './stack.ts';

export interface SymbolicateOptions {
  cwd: string;
  issue: string;
  /** The crashing version's commit. */
  base: string;
  expected?: Expected;
  projectDir?: string;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export function symbolicateIssue(opts: SymbolicateOptions): SiteResolution {
  const log = opts.log ?? (() => {});
  const project = openProject(opts.cwd, opts.projectDir, opts.runner);
  let resolved;
  try {
    resolved = resolveExpectation(project.common, opts.issue, opts.expected);
  } catch (e) {
    throw new VerifyError((e as Error).message);
  }
  const { expected } = resolved;
  if (!expected.js) throw new VerifyError(`issue ${opts.issue}'s recorded failure, ${expected.exception} at ${expected.frame}, is not a JS error`);
  checkRunnerFits(project, expected);
  const base = resolveRef(project, opts.base);
  const ctx = runContext(project, {
    logPrefix: `symbolicate-${opts.issue.slice(0, 12)}`,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    test: '',
    targetFile: '',
    overlay: [],
    expected,
  });
  const version = expected.js.version ? `, version ${expected.js.version.display} (${expected.js.version.build})` : '';
  log(`fixcrash symbolicate: issue ${opts.issue}, ${expected.exception} at ${expected.frame} (${expected.js.platform}${version}), at ${short(base)}`);
  const unlock = lock(project);
  try {
    return resolveJsSite(ctx, base);
  } finally {
    unlock();
  }
}
