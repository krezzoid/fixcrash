// What the fixcrash hook records from Crashlytics events, so that verify and
// reproduce check against the event itself rather than the agent's reading
// of it. Lives in .git/fixcrash/, which the hook keeps the agent from writing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CrashEvent, Expectation } from './event.ts';
import { expectationOf } from './event.ts';
import { stateDir } from './receipt.ts';

export interface RecordedExpectation extends Expectation {
  /** The event it came from. */
  event: string;
  variant?: string;
}

export interface IssueRecord {
  schema: 1;
  issue: string;
  title: string;
  errorType: string;
  expectations: RecordedExpectation[];
  versions: { display: string; build: string; revision?: string }[];
  updatedAt: string;
}

export type ExpectationSource = 'event' | 'arguments';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function checkId(kind: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`not a valid ${kind}: ${id}`);
  return id;
}

export function recordPath(gitCommonDir: string, issue: string): string {
  return join(stateDir(gitCommonDir), 'events', `${checkId('issue id', issue)}.json`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function readRecord(gitCommonDir: string, issue: string): IssueRecord | undefined {
  const path = recordPath(gitCommonDir, issue);
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, 'utf8')) as IssueRecord;
  return record.schema === 1 ? record : undefined;
}

/** Adds an event's expectation and version to its issue's record. Returns the expectation, if the event has one. */
export function recordEvent(gitCommonDir: string, event: CrashEvent): Expectation | undefined {
  const record: IssueRecord = readRecord(gitCommonDir, event.issueId) ?? {
    schema: 1, issue: event.issueId, title: event.issueTitle, errorType: event.errorType,
    expectations: [], versions: [], updatedAt: '',
  };
  const expected = expectationOf(event);
  if (expected && !record.expectations.some((e) => e.exception === expected.exception && e.frame === expected.frame)) {
    const entry: RecordedExpectation = { ...expected, event: event.name };
    if (event.variant) entry.variant = event.variant;
    record.expectations.push(entry);
  }
  if (event.version) {
    const v = { ...event.version, ...(event.revision ? { revision: event.revision } : {}) };
    if (!record.versions.some((x) => x.display === v.display && x.build === v.build && x.revision === v.revision)) {
      record.versions.push(v);
    }
  }
  record.updatedAt = new Date().toISOString();
  writeJson(recordPath(gitCommonDir, event.issueId), record);
  return expected;
}

/**
 * The failure a test must reproduce for `issue`: from the recorded events,
 * or from the caller when none is recorded. A caller's expectation that
 * contradicts the recorded events is refused.
 */
export function resolveExpectation(
  gitCommonDir: string,
  issue: string,
  given?: Expectation,
): { expected: Expectation; source: ExpectationSource } {
  const record = readRecord(gitCommonDir, issue);
  const recorded = record?.expectations ?? [];
  const list = recorded.map((e) => `${e.exception} at ${e.frame}`).join('; ');
  // The crash site comes from the event only, never from the caller.
  const fromEvent = ({ exception, frame, site }: RecordedExpectation): Expectation =>
    site ? { exception, frame, site } : { exception, frame };
  if (given) {
    if (recorded.length === 0) return { expected: { exception: given.exception, frame: given.frame }, source: 'arguments' };
    const match = recorded.find((e) => e.exception === given.exception && e.frame === given.frame);
    if (match) return { expected: fromEvent(match), source: 'event' };
    throw new Error(`issue ${issue}'s recorded events expect ${list}, not ${given.exception} at ${given.frame}`);
  }
  if (recorded.length === 0) {
    throw new Error(
      `no recorded event for issue ${issue}: fetch one with crashlytics_batch_get_events (the fixcrash hook records it), or pass --exception and --frame`,
    );
  }
  if (recorded.length > 1) throw new Error(`issue ${issue} has several recorded failures (${list}): pass --exception and --frame to pick one`);
  return { expected: fromEvent(recorded[0]!), source: 'event' };
}

/** Marks a session as one that read crash events in this repository: the PR guard applies to it. */
export function markSession(gitCommonDir: string, sessionId: string): void {
  const path = join(stateDir(gitCommonDir), 'sessions', checkId('session id', sessionId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`);
}

export function sessionActive(gitCommonDir: string, sessionId: string): boolean {
  return SAFE_ID.test(sessionId) && existsSync(join(stateDir(gitCommonDir), 'sessions', sessionId));
}
