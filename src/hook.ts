// The fixcrash hook: the rules that hold in code, not in a prompt.
//
// PostToolUse on Crashlytics tools:
//   - redact personal data from the result before the model sees it;
//   - record each event's expected failure for verify and reproduce;
//   - mark the session, which turns the PR guard on.
// PreToolUse:
//   - PR guard: no pull request without a valid receipt for the commit it proposes;
//   - fixcrash state in .git/fixcrash is written by the CLI only;
//   - the reproducer subagent writes test files only.
//
// Fails closed: an error while checking a PR or a state write blocks it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { checkReceipt } from './receipt.ts';
import { parseEvents, redactToolOutput, toCrashEvent } from './event.ts';
import * as g from './git.ts';
import { markSession, recordEvent, sessionActive } from './record.ts';

export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  agent_type?: string;
}

export interface HookOutput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const ALLOW: HookOutput = { exitCode: 0 };

const REPRODUCER = 'fixcrash:reproducer';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const CRASHLYTICS_TOOL = /^mcp__.+__crashlytics_[a-z_]+$/;
const EVENT_TOOL = /__crashlytics_(batch_get_events|list_events)$/;
const MCP_CREATE_PR = /^mcp__.+__(create_pull_request|pull_request_create|createPullRequest)$/i;

function deny(reason: string): HookOutput {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `fixcrash: ${reason}` },
    }),
  };
}

const slashes = (p: string) => p.replace(/\\/g, '/');

/** A path is a test source: Gradle `src/test*`, Jest `__tests__` or `*.test.*`, Swift `*Tests/`. */
export function isTestPath(path: string): boolean {
  const p = slashes(path);
  return /\/src\/test[A-Za-z0-9]*\//.test(p) || /\/__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /\/[A-Za-z0-9]*Tests\/.+\.swift$/.test(p);
}

const STATE_PATH = /\.git[\\/]+fixcrash(?=$|[\\/\s'"])/;
const STATE_SUBDIR = /fixcrash[\\/]+(receipts|events|attempts|sessions|lock)\b/;

/** A shell command that reaches into fixcrash's state, other than reading logs. */
export function touchesState(command: string): boolean {
  if (STATE_SUBDIR.test(command)) return true;
  const mentions = [...command.matchAll(new RegExp(STATE_PATH.source, 'g'))];
  return mentions.some((m) => !/^[\\/]+logs\b/.test(command.slice(m.index + m[0].length)));
}

export interface PrTarget {
  /** Branch the PR proposes, if the command names one. */
  head?: string;
  /** Directory the command changes to before opening the PR, relative to the session's. */
  dir?: string;
}

/** The last `cd <dir>` before `index` in a shell command. */
function cdBefore(command: string, index: number): string | undefined {
  const cds = [...command.slice(0, index).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)];
  return cds[cds.length - 1]?.[1]?.replace(/^["']|["']$/g, '');
}

/** A shell command that opens a pull request, and the branch it names. */
export function shellPr(command: string): PrTarget | undefined {
  const headOf = (s: string) => s.match(/(?:--head|-H)[=\s]+["']?([^\s"']+)/)?.[1];
  const target = (index: number, head: string | undefined): PrTarget => {
    const t: PrTarget = { head };
    const dir = cdBefore(command, index);
    if (dir) t.dir = dir;
    return t;
  };
  const create = command.match(/\bgh\s+pr\s+create\b|\bhub\s+pull-request\b/);
  if (create) return target(create.index!, headOf(command.slice(create.index)));
  const api = command.match(/\bgh\s+api\b[^;&|\n]*/);
  if (api && /\bpulls\b/.test(api[0]) && /(\s-X\s*POST|\s--method[=\s]+POST|\s-f\s|\s-F\s|\s--field\b|\s--raw-field\b|\s--input\b)/i.test(api[0])) {
    return target(api.index!, api[0].match(/\bhead=([^\s"']+)/)?.[1]);
  }
  return undefined;
}

function prGuard(input: HookInput, target: PrTarget): HookOutput {
  const sessionDir = input.cwd ?? process.cwd();
  const cwd = target.dir ? resolve(sessionDir, target.dir.replace(/^~(?=\/|$)/, homedir())) : sessionDir;
  let root: string;
  try {
    root = g.repoRoot(cwd);
  } catch {
    return ALLOW; // not a git repository: nothing fixcrash made
  }
  const common = g.commonDir(root);
  const branch = target.head?.replace(/^[^:]+:/, '') ?? g.tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '';
  const active = sessionActive(common, input.session_id ?? '') || branch.startsWith('fixcrash/');
  if (!active) return ALLOW;

  const commit = g.tryGit(root, ['rev-parse', '--verify', '--quiet', `${branch || 'HEAD'}^{commit}`]);
  if (!commit) return deny(`cannot find the commit of branch ${branch} to check its receipt`);
  const check = checkReceipt(common, commit);
  const how = 'Run `fixcrash verify` on the committed test and fix first. If the crash cannot be reproduced, report instead of opening a pull request.';
  if (!check.ok) return deny(`no pull request without proof: ${check.reason}. ${how}`);
  if (check.receipt.expectedSource !== 'event') {
    return deny(`the receipt for ${commit.slice(0, 12)} checked a failure given on the command line, not one recorded from the Crashlytics event. Fetch the issue's event with crashlytics_batch_get_events, then verify again without --exception and --frame.`);
  }
  return ALLOW;
}

function preToolUse(input: HookInput): HookOutput {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};

  if (FILE_TOOLS.has(tool)) {
    const path = slashes(String(ti.file_path ?? ti.notebook_path ?? ''));
    if (STATE_PATH.test(path)) return deny('.git/fixcrash holds receipts and recorded crash events: only the fixcrash CLI writes there');
    if (input.agent_type === REPRODUCER && !isTestPath(path)) {
      return deny(`the reproducer writes tests only, and ${path} is not a test source. Reproduce the crash with a test; the fix comes later, in the main session.`);
    }
    return ALLOW;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = String(ti.command ?? '');
    if (touchesState(command)) {
      return deny('.git/fixcrash holds receipts and recorded crash events: read them with `fixcrash receipt` and `fixcrash event`, and let the fixcrash CLI write them');
    }
    const pr = shellPr(command);
    return pr ? prGuard(input, pr) : ALLOW;
  }
  if (MCP_CREATE_PR.test(tool)) return prGuard(input, { head: typeof ti.head === 'string' ? ti.head : undefined });
  return ALLOW;
}

interface TextBlock {
  type: string;
  text?: string;
}

function postCrashlytics(input: HookInput): HookOutput {
  const response = input.tool_response;
  const blocks: TextBlock[] | undefined = Array.isArray(response)
    ? (response as TextBlock[])
    : typeof response === 'string' ? [{ type: 'text', text: response }] : undefined;
  if (!blocks) return ALLOW;

  const notes: string[] = [];
  const total = new Map<string, number>();
  const redacted = blocks.map((b) => {
    if (b.type !== 'text' || typeof b.text !== 'string') return b;
    const { text, counts } = redactToolOutput(b.text);
    for (const [k, v] of counts) total.set(k, (total.get(k) ?? 0) + v);
    return { ...b, text };
  });

  if (EVENT_TOOL.test(input.tool_name ?? '')) {
    let common: string | undefined;
    try {
      common = g.commonDir(g.repoRoot(input.cwd ?? process.cwd()));
    } catch {
      notes.push('Not in a git repository, so the expected failure was not recorded: run Claude Code from the app repository.');
    }
    if (common) {
      for (const b of blocks) {
        if (b.type !== 'text' || typeof b.text !== 'string') continue;
        for (const fields of parseEvents(b.text)) {
          const event = toCrashEvent(fields);
          if (!event) continue;
          const expected = recordEvent(common, event);
          notes.push(expected
            ? `Recorded the expected failure for issue ${event.issueId}: ${expected.exception} at ${expected.frame}. fixcrash reproduce and verify check against it.`
            : `Issue ${event.issueId}: this event has no blame frame or exceptions, so there is no expected failure to reproduce.`);
        }
      }
      if (input.session_id) markSession(common, input.session_id);
    }
  }

  if (total.size > 0) {
    const what = [...total].map(([k, v]) => `${k} ${v}`).join(', ');
    notes.unshift(`Redacted personal data from this result before you saw it (${what}). Placeholders such as <email> and <redacted> stand for it: never try to recover it, and use synthetic values in tests.`);
  }
  if (notes.length === 0) return ALLOW;
  const output: Record<string, unknown> = { hookEventName: 'PostToolUse', additionalContext: `fixcrash: ${notes.join(' ')}` };
  if (total.size > 0) output.updatedToolOutput = Array.isArray(response) ? redacted : redacted[0]!.text;
  return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: output }) };
}

/** Could this input be a PR or a state write? Then an error must block it. */
function sensitive(input: HookInput): boolean {
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (MCP_CREATE_PR.test(tool)) return true;
  if (SHELL_TOOLS.has(tool)) {
    const c = String(ti.command ?? '');
    return /\bpr\s+create\b|pull-request|\bpulls\b|\.git[\\/]+fixcrash/.test(c);
  }
  if (FILE_TOOLS.has(tool)) return /\.git[\\/]+fixcrash/.test(String(ti.file_path ?? ti.notebook_path ?? ''));
  return false;
}

export function handle(input: HookInput): HookOutput {
  try {
    if (input.hook_event_name === 'PreToolUse') return preToolUse(input);
    if (input.hook_event_name === 'PostToolUse' && CRASHLYTICS_TOOL.test(input.tool_name ?? '')) return postCrashlytics(input);
    return ALLOW;
  } catch (e) {
    if (input.hook_event_name === 'PreToolUse' && sensitive(input)) return deny(`the check failed, so the action is blocked: ${(e as Error).message}`);
    return { exitCode: 0, stderr: `fixcrash hook: ${(e as Error).stack ?? e}` };
  }
}

if (import.meta.main) {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch (e) {
    // Not exit 2: that would block every tool call, not just the ones fixcrash guards.
    process.stderr.write(`fixcrash hook: cannot read the hook input: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const out = handle(input);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}
