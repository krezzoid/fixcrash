// `fixcrash pr-body`: the pull request description, built from the receipt
// only. It carries class names, file paths, shas and counts, and on iOS what
// the crashing commit's own debug symbols say about the crash site; no event data.

import type { Receipt, RunRecord } from './receipt.ts';

const short = (sha: string) => sha.slice(0, 12);

/** `com.example.FooTest.bar` -> `FooTest.bar`. */
function shortName(name: string): string {
  const parts = name.split('.');
  const cls = parts.findIndex((p) => /^[A-Z]/.test(p));
  return cls >= 0 ? parts.slice(cls).join('.') : name;
}

function failed(run: RunRecord): string {
  const t = run.target[0];
  if (!t) return run.reason;
  const more = run.target.length > 1 ? ` (and ${run.target.length - 1} more cases)` : '';
  return `\`${shortName(t.name)}\` fails as the crash did: \`${t.exception}\` at \`${shortName(t.frame ?? '')}\`${more}`;
}

export function prBody(r: Receipt): string {
  const base = r.runs.find((x) => x.role === 'base');
  const from = r.runs.find((x) => x.role === 'from');
  const head = r.runs.find((x) => x.role === 'head');
  const rows = [
    base && `| Crashing version | \`${short(base.commit)}\` | ${failed(base)} |`,
    from
      ? `| Where the fix starts | \`${short(from.commit)}\` | ${failed(from)} |`
      : `| Where the fix starts | \`${short(r.from)}\` | same commit as the crashing version |`,
    head && `| This branch | \`${short(head.commit)}\` | \`${shortName(r.test)}\` passes; full suite green: ${head.tests.total} tests, ${head.tests.skipped} skipped |`,
  ].filter(Boolean);
  const source = r.expectedSource === 'event'
    ? 'the Crashlytics event, as recorded by the fixcrash hook'
    : "verify's arguments (no recorded Crashlytics event)";
  return [
    `Fixes Crashlytics issue \`${r.issue}\`: \`${r.expected.exception}\` at \`${r.expected.frame}\`.`,
    '',
    '## Proof',
    '',
    '`fixcrash verify` ran the new test in a clean worktree at each commit below, from committed code.',
    '',
    '| Where | Commit | Result |',
    '|-------|--------|--------|',
    ...rows,
    '',
    `- Test: ${r.testFiles.map((f) => `\`${f}\``).join(', ')}`,
    `- Fix: ${r.fixFiles.map((f) => `\`${f}\``).join(', ')}`,
    `- Expected failure (exception type and blame frame): from ${source}.`,
    ...(r.crashSite ? [`- Crash site, from a release build of the crashing version: ${r.crashSite.note}.`] : []),
    '',
    `<sub>fixcrash ${r.fixcrash}, receipt for \`${r.head}\`.</sub>`,
    '',
  ].join('\n');
}
