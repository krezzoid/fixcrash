// bin/fixcrash: verify | reproduce | symbolicate | commit-for-version | receipt | pr-body | event | app-id
// Exit codes: 0 done, 1 not verified / not reproduced / not found,
// 2 bad input or environment, 3 reproduce budget spent.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appIdsIn } from './appid.ts';
import { commonDir, GitError, repoRoot, resolveCommit } from './git.ts';
import { prBody } from './prbody.ts';
import { checkReceipt } from './receipt.ts';
import { readRecord } from './record.ts';
import { reproduce } from './reproduce.ts';
import { symbolicateIssue } from './symbolicate.ts';
import type { Expected } from './stack.ts';
import { verify, VerifyError } from './verify.ts';
import { commitForVersion, DEFAULT_TAG_PATTERNS, VersionError } from './version.ts';

const USAGE = `usage:
  fixcrash reproduce --issue <id> --test <Class.method> --base <commit> --hypothesis <text>
                     [--max-attempts <n>] [--max-hypotheses <n>] [--run <id>]
                     [--exception <type> --frame <symbol>] [--project-dir <dir>] [--timeout <minutes>]
      Runs the new test, uncommitted in the working tree, at --base (the crashing
      version) and says whether it fails as the crash did. Counts attempts and
      hypotheses per issue and --run; past the budget it exits 3: stop and report.

  fixcrash verify --issue <id> --test <Class.method> --base <commit> [--from <commit>]
                  [--exception <type> --frame <symbol>] [--project-dir <dir>] [--timeout <minutes>]
      Proves a fix committed at HEAD. The test must fail at --base (the crashing
      version) and at --from (where the fix starts; default: merge-base with the
      default branch) as the crash did; with the fix it must pass and the full
      suite must be green. Writes a receipt for HEAD.

  Both take the expected failure from the issue's Crashlytics event, as the
  fixcrash hook recorded it. --exception and --frame pick one when the issue
  has several, or stand in when none is recorded (a PR then needs a re-verify).
  A React Native JS error runs with Jest, from the app's root: --test is
  <test file>::<the test's full name>, and its failure needs its recorded event.

  fixcrash symbolicate --issue <id> --base <commit> [--exception <type> --frame <frame>] [--project-dir <dir>]
      Where a recorded React Native JS error is in the app's sources at --base:
      builds that commit's bundle and source map, and maps the event's frames.

  fixcrash commit-for-version <display> <build> [--revision <sha>] [--tag-pattern <pattern>]...
      The commit a build was made from: --revision (the event's build stamp), or
      the first existing tag from the patterns ({display}, {build}; default: ${DEFAULT_TAG_PATTERNS.join(', ')}).

  fixcrash event <issue>          What the hook recorded for an issue: expected failures, versions.
  fixcrash receipt [--commit <ref>]   The receipt for HEAD (or --commit) if valid; exit 1 if not.
  fixcrash pr-body [--commit <ref>]   A pull request description from that receipt.
  fixcrash app-id [--project-dir <dir>]   Firebase app ids from GoogleService-Info.plist files, and from google-services.json
                                          files: the app whose package is the module's applicationId, if it is there.`;

class UsageError extends Error {}

function required(values: Record<string, unknown>, names: string[]): void {
  const missing = names.filter((n) => typeof values[n] !== 'string' || values[n] === '');
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

function expectedFrom(values: { exception?: string; frame?: string }): Expected | undefined {
  if (values.exception === undefined && values.frame === undefined) return undefined;
  if (!values.exception || !values.frame) throw new UsageError('--exception and --frame go together');
  return { exception: values.exception, frame: values.frame };
}

function positive(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!(n > 0)) throw new UsageError(`--${name} must be a positive number`);
  return n;
}

const RUN_OPTIONS = {
  issue: { type: 'string' },
  test: { type: 'string' },
  exception: { type: 'string' },
  frame: { type: 'string' },
  base: { type: 'string' },
  'project-dir': { type: 'string' },
  timeout: { type: 'string' },
} as const;

function cmdVerify(args: string[]): number {
  const { values } = parseArgs({ args, options: { ...RUN_OPTIONS, from: { type: 'string' } }, strict: true });
  required(values, ['issue', 'test', 'base']);
  const result = verify({
    cwd: process.cwd(),
    issue: values.issue!,
    test: values.test!,
    expected: expectedFrom(values),
    base: values.base!,
    from: values.from,
    projectDir: values['project-dir'],
    timeoutMs: positive(values.timeout, 'timeout', 30) * 60_000,
    log: (line) => console.log(line),
  });
  return result.verified ? 0 : 1;
}

function cmdReproduce(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      ...RUN_OPTIONS,
      hypothesis: { type: 'string' },
      'max-attempts': { type: 'string' },
      'max-hypotheses': { type: 'string' },
      run: { type: 'string' },
    },
    strict: true,
  });
  required(values, ['issue', 'test', 'base', 'hypothesis']);
  const result = reproduce({
    cwd: process.cwd(),
    issue: values.issue!,
    test: values.test!,
    base: values.base!,
    hypothesis: values.hypothesis!,
    maxAttempts: positive(values['max-attempts'], 'max-attempts', 5),
    maxHypotheses: positive(values['max-hypotheses'], 'max-hypotheses', 3),
    run: values.run,
    expected: expectedFrom(values),
    projectDir: values['project-dir'],
    timeoutMs: positive(values.timeout, 'timeout', 30) * 60_000,
    log: (line) => console.log(line),
  });
  return { reproduced: 0, 'not-reproduced': 1, 'budget-spent': 3 }[result.status];
}

function cmdSymbolicate(args: string[]): number {
  const { values } = parseArgs({ args, options: RUN_OPTIONS, strict: true });
  required(values, ['issue', 'base']);
  const site = symbolicateIssue({
    cwd: process.cwd(),
    issue: values.issue!,
    base: values.base!,
    expected: expectedFrom(values),
    projectDir: values['project-dir'],
    timeoutMs: positive(values.timeout, 'timeout', 30) * 60_000,
    log: (line) => console.log(line),
  });
  for (const line of site.chain ?? []) console.log(`  at ${line}`);
  console.log(`crash site: ${site.note}`);
  console.log(`expect ${site.expected.exception} at ${site.expected.frame}`);
  return 0;
}

function cmdCommitForVersion(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      revision: { type: 'string' },
      'tag-pattern': { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 2) throw new UsageError('commit-for-version takes <display> <build>');
  const [display, build] = positionals as [string, string];
  const found = commitForVersion(process.cwd(), display, build, {
    revision: values.revision,
    tagPatterns: values['tag-pattern'],
  });
  console.log(found.commit);
  console.error(`fixcrash: ${display} (${build}) was built from ${found.commit}, by ${found.source}`);
  return 0;
}

function receiptFor(args: string[]) {
  const { values } = parseArgs({ args, options: { commit: { type: 'string' } }, strict: true });
  const cwd = process.cwd();
  return checkReceipt(commonDir(cwd), resolveCommit(cwd, values.commit ?? 'HEAD'));
}

function cmdReceipt(args: string[]): number {
  const check = receiptFor(args);
  if (!check.ok) {
    console.error(`fixcrash: ${check.reason}`);
    return 1;
  }
  console.log(JSON.stringify(check.receipt, null, 2));
  return 0;
}

function cmdPrBody(args: string[]): number {
  const check = receiptFor(args);
  if (!check.ok) {
    console.error(`fixcrash: ${check.reason}`);
    return 1;
  }
  process.stdout.write(prBody(check.receipt));
  return 0;
}

function cmdEvent(args: string[]): number {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  if (positionals.length !== 1) throw new UsageError('event takes <issue>');
  const record = readRecord(commonDir(process.cwd()), positionals[0]!);
  if (!record) {
    console.error(`fixcrash: nothing recorded for issue ${positionals[0]}: fetch an event with crashlytics_batch_get_events first`);
    return 1;
  }
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

function cmdAppId(args: string[]): number {
  const { values } = parseArgs({ args, options: { 'project-dir': { type: 'string' } }, strict: true });
  const dir = values['project-dir'] ? resolve(values['project-dir']) : repoRoot(process.cwd());
  const found = appIdsIn(dir);
  for (const a of found) console.log(`${a.id}\t${a.app}\t${a.file}`);
  if (found.length === 0) {
    console.error('fixcrash: no google-services.json or GoogleService-Info.plist with an app id here: pass the app id, or set it in the plugin options');
  }
  return found.length > 0 ? 0 : 1;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'verify':
        return cmdVerify(rest);
      case 'reproduce':
        return cmdReproduce(rest);
      case 'symbolicate':
        return cmdSymbolicate(rest);
      case 'commit-for-version':
        return cmdCommitForVersion(rest);
      case 'receipt':
        return cmdReceipt(rest);
      case 'pr-body':
        return cmdPrBody(rest);
      case 'event':
        return cmdEvent(rest);
      case 'app-id':
        return cmdAppId(rest);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`fixcrash: ${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof VersionError) {
      console.error(`fixcrash: ${e.message}`);
      return 1;
    }
    if (e instanceof VerifyError || e instanceof GitError) {
      console.error(`fixcrash: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
