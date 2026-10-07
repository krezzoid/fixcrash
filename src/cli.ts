// bin/fixcrash: verify | commit-for-version | receipt
// Exit codes: 0 done, 1 not verified / not found, 2 bad input or environment.

import { parseArgs } from 'node:util';
import { commonDir, GitError, resolveCommit } from './git.ts';
import { checkReceipt } from './receipt.ts';
import { verify, VerifyError } from './verify.ts';
import { commitForVersion, DEFAULT_TAG_PATTERNS, VersionError } from './version.ts';

const USAGE = `usage:
  fixcrash verify --issue <id> --test <Class.method> --exception <type> --frame <symbol>
                  --base <commit> [--from <commit>] [--project-dir <dir>] [--timeout <minutes>]
      Proves a fix committed at HEAD. The test must fail at --base (the crashing
      version) and at --from (where the fix starts; default: merge-base with the
      default branch) with --exception, passing through --frame; with the fix it
      must pass and the full suite must be green. Writes a receipt for HEAD.

  fixcrash commit-for-version <display> <build> [--revision <sha>] [--tag-pattern <pattern>]...
      The commit a build was made from: --revision (the event's build stamp), or
      the first existing tag from the patterns ({display}, {build}; default: ${DEFAULT_TAG_PATTERNS.join(', ')}).

  fixcrash receipt [--commit <ref>]
      Prints the receipt for HEAD (or --commit) if it is valid; exit 1 if not.`;

class UsageError extends Error {}

function required(values: Record<string, unknown>, names: string[]): void {
  const missing = names.filter((n) => typeof values[n] !== 'string' || values[n] === '');
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

function cmdVerify(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      issue: { type: 'string' },
      test: { type: 'string' },
      exception: { type: 'string' },
      frame: { type: 'string' },
      base: { type: 'string' },
      from: { type: 'string' },
      'project-dir': { type: 'string' },
      timeout: { type: 'string' },
    },
    strict: true,
  });
  required(values, ['issue', 'test', 'exception', 'frame', 'base']);
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const minutes = Number(values.timeout);
    if (!(minutes > 0)) throw new UsageError('--timeout must be a positive number of minutes');
    timeoutMs = minutes * 60_000;
  }
  const result = verify({
    cwd: process.cwd(),
    issue: values.issue!,
    test: values.test!,
    expected: { exception: values.exception!, frame: values.frame! },
    base: values.base!,
    from: values.from,
    projectDir: values['project-dir'],
    timeoutMs,
    log: (line) => console.log(line),
  });
  return result.verified ? 0 : 1;
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

function cmdReceipt(args: string[]): number {
  const { values } = parseArgs({ args, options: { commit: { type: 'string' } }, strict: true });
  const cwd = process.cwd();
  const commit = resolveCommit(cwd, values.commit ?? 'HEAD');
  const check = checkReceipt(commonDir(cwd), commit);
  if (!check.ok) {
    console.error(`fixcrash: ${check.reason}`);
    return 1;
  }
  console.log(JSON.stringify(check.receipt, null, 2));
  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'verify':
        return cmdVerify(rest);
      case 'commit-for-version':
        return cmdCommitForVersion(rest);
      case 'receipt':
        return cmdReceipt(rest);
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
