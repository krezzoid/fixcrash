// The receipt: written by `fixcrash verify` only when a fix is proven, bound
// to the commit it proves. The PR guard accepts a PR only with a valid
// receipt for HEAD.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExpectationSource } from './record.ts';
import type { Expected } from './stack.ts';
import type { TestStatus } from './junit.ts';

export const RECEIPT_SCHEMA = 2;

export interface TargetResult {
  name: string;
  status: TestStatus;
  exception?: string;
  message?: string;
  /** The expected frame as it appeared in the test's stack, with file and line. */
  frame?: string;
  /** The first frames of the throwable that matched, for the PR body. */
  top?: string[];
}

export interface RunRecord {
  role: 'base' | 'from' | 'head';
  commit: string;
  command: string[];
  exitCode: number | null;
  durationMs: number;
  log: string;
  tests: { total: number; failed: number; skipped: number };
  target: TargetResult[];
  ok: boolean;
  /** Why the run did not pass its check, or what it showed. */
  reason: string;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  verified: true;
  /** The commit the receipt proves: the fix. */
  head: string;
  /** The crashing version's commit, where the test reproduced the crash. */
  base: string;
  /** The commit the fix starts from, where the test also failed. */
  from: string;
  issue: string;
  test: string;
  expected: Expected;
  /** Where `expected` came from: the Crashlytics event recorded by the hook, or verify's arguments. */
  expectedSource: ExpectationSource;
  projectDir: string;
  runner: string;
  testFiles: string[];
  fixFiles: string[];
  runs: RunRecord[];
  createdAt: string;
  fixcrash: string;
}

/** Where fixcrash keeps its state in a repository: inside the git directory, never committed. */
export function stateDir(gitCommonDir: string): string {
  return join(gitCommonDir, 'fixcrash');
}

export function receiptPath(gitCommonDir: string, commit: string): string {
  return join(stateDir(gitCommonDir), 'receipts', `${commit}.json`);
}

export function writeReceipt(gitCommonDir: string, receipt: Receipt): string {
  const path = receiptPath(gitCommonDir, receipt.head);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

export type ReceiptCheck = { ok: true; receipt: Receipt; path: string } | { ok: false; reason: string };

/** The receipt for `commit`, if one exists and proves that commit. */
export function checkReceipt(gitCommonDir: string, commit: string): ReceiptCheck {
  const path = receiptPath(gitCommonDir, commit);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: `no receipt for ${commit.slice(0, 12)}: run fixcrash verify on this commit` };
  }
  let receipt: Partial<Receipt>;
  try {
    receipt = JSON.parse(raw) as Partial<Receipt>;
  } catch {
    return { ok: false, reason: `receipt ${path} is not valid JSON` };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) {
    return { ok: false, reason: `receipt ${path} has schema ${String(receipt.schema)}, expected ${RECEIPT_SCHEMA}: verify again` };
  }
  if (receipt.head !== commit) return { ok: false, reason: `receipt ${path} is for ${String(receipt.head)}, not ${commit}` };
  if (receipt.verified !== true) return { ok: false, reason: `receipt ${path} does not say verified` };
  const roles = new Set((receipt.runs ?? []).filter((r) => r.ok).map((r) => r.role));
  if (!roles.has('base') || !roles.has('head')) {
    return { ok: false, reason: `receipt ${path} lacks a passing base or head run` };
  }
  return { ok: true, receipt: receipt as Receipt, path };
}
