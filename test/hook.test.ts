import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { handle, isTestPath, shellPr, touchesState, type HookInput, type HookOutput } from '../src/hook.ts';
import { readRecord } from '../src/record.ts';
import { writeReceipt, type Receipt } from '../src/receipt.ts';
import { commit, initRepo, sh, tempDir } from './helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/crashlytics/${name}`, import.meta.url), 'utf8');
const SESSION = 'session-1';
const EVENTS_TOOL = 'mcp__plugin_fixcrash_firebase__crashlytics_batch_get_events';

function repo(t: Parameters<typeof tempDir>[0]): string {
  const dir = tempDir(t);
  initRepo(dir, { 'README.md': 'x\n' });
  return dir;
}

function pre(cwd: string, tool: string, toolInput: Record<string, unknown>, extra: Partial<HookInput> = {}): HookOutput {
  return handle({ hook_event_name: 'PreToolUse', session_id: SESSION, cwd, tool_name: tool, tool_input: toolInput, ...extra });
}

function decision(out: HookOutput): { permissionDecision: string; permissionDecisionReason: string } | undefined {
  return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : undefined;
}

function denied(out: HookOutput): string {
  const d = decision(out);
  assert.equal(d?.permissionDecision, 'deny', `expected a deny, got ${out.stdout ?? 'no output'}`);
  return d!.permissionDecisionReason;
}

function postEvents(cwd: string, text = fixture('event-npe.yaml')): HookOutput {
  return handle({
    hook_event_name: 'PostToolUse', session_id: SESSION, cwd, tool_name: EVENTS_TOOL,
    tool_input: {}, tool_response: [{ type: 'text', text }],
  });
}

function receipt(head: string, expectedSource: Receipt['expectedSource']): Receipt {
  const run = (role: 'base' | 'head') => ({
    role, commit: head, command: [], exitCode: 0, durationMs: 1, log: 'x', tests: { total: 1, failed: 0, skipped: 0 }, target: [], ok: true, reason: '',
  });
  return {
    schema: 2, verified: true, head, base: head, from: head, issue: 'i', test: 't', expected: { exception: 'e', frame: 'f' },
    expectedSource, projectDir: '', runner: 'gradle', testFiles: [], fixFiles: [], runs: [run('base'), run('head')],
    createdAt: '', fixcrash: '0.0.0',
  };
}

test('tells test sources from app sources', () => {
  for (const p of ['/r/app/src/test/java/a/BTest.kt', '/r/app/src/testDebug/kotlin/X.kt', '/r/src/__tests__/a.js', '/r/src/a.test.ts', '/r/AppTests/FooTests.swift', 'C:\\r\\app\\src\\test\\A.kt']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['/r/app/src/main/java/a/B.kt', '/r/app/build.gradle.kts', '/r/src/latest/a.kt', '/r/README.md']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('spots shell commands that reach into fixcrash state, logs aside', () => {
  for (const c of [
    'cat .git/fixcrash/receipts/abc.json',
    'echo {} > /repo/.git/fixcrash/events/i.json',
    'rm -rf .git/fixcrash',
    'cd .git && ls fixcrash/attempts',
    'cp x "/repo/.git/fixcrash/sessions/s"',
  ]) {
    assert.equal(touchesState(c), true, c);
  }
  for (const c of ['tail -50 .git/fixcrash/logs/abc-base.log', 'fixcrash receipt', 'git status', 'ls src/fixcrash.ts']) {
    assert.equal(touchesState(c), false, c);
  }
});

test('spots commands that open a pull request, and the branch they name', () => {
  assert.deepEqual(shellPr('gh pr create --fill'), { head: undefined });
  assert.deepEqual(shellPr('cd app && gh pr create -H fixcrash/abc --title "Fix"'), { head: 'fixcrash/abc', dir: 'app' });
  assert.deepEqual(shellPr('cd "/tmp/my repo"; cd sub && gh pr create'), { head: undefined, dir: 'sub' });
  assert.deepEqual(shellPr('gh pr create --head=me:fixcrash/abc'), { head: 'me:fixcrash/abc' });
  assert.deepEqual(shellPr('gh api repos/o/r/pulls -f title=x -f head=fixcrash/abc -f base=main'), { head: 'fixcrash/abc' });
  assert.deepEqual(shellPr('hub pull-request -m x'), { head: undefined });
  assert.equal(shellPr('gh api repos/o/r/pulls'), undefined);
  assert.equal(shellPr('gh pr list && gh pr view 3'), undefined);
  assert.equal(shellPr('git push origin fixcrash/abc'), undefined);
});

test('lets pull requests through in sessions that read no crash events', (t) => {
  const dir = repo(t);
  assert.deepEqual(pre(dir, 'Bash', { command: 'gh pr create --fill' }), { exitCode: 0 });
});

test('blocks a pull request without a receipt once the session read crash events', (t) => {
  const dir = repo(t);
  postEvents(dir);

  const reason = denied(pre(dir, 'Bash', { command: 'gh pr create --fill' }));

  assert.match(reason, /no pull request without proof: no receipt for \w{12}/);
  assert.match(reason, /report instead of opening a pull request/);
});

test('blocks a pull request from a fixcrash branch in any session', (t) => {
  const dir = repo(t);
  sh(dir, 'git', 'switch', '--quiet', '-c', 'fixcrash/c0de');

  denied(pre(dir, 'Bash', { command: 'gh pr create --fill' }, { session_id: 'another' }));
});

test('accepts a receipt for the proposed commit whose expectation came from the event', (t) => {
  const dir = repo(t);
  postEvents(dir);
  const head = sh(dir, 'git', 'rev-parse', 'HEAD');

  writeReceipt(join(dir, '.git'), receipt(head, 'arguments'));
  assert.match(denied(pre(dir, 'Bash', { command: 'gh pr create --fill' })), /given on the command line/);

  writeReceipt(join(dir, '.git'), receipt(head, 'event'));
  assert.deepEqual(pre(dir, 'Bash', { command: 'gh pr create --fill' }), { exitCode: 0 });
});

test('checks the branch a pull request names, through gh or a GitHub MCP tool', (t) => {
  const dir = repo(t);
  postEvents(dir);
  sh(dir, 'git', 'switch', '--quiet', '-c', 'fixcrash/c0de');
  const fixed = commit(dir, { 'fix.txt': 'fix\n' }, 'fix');
  writeReceipt(join(dir, '.git'), receipt(fixed, 'event'));
  sh(dir, 'git', 'switch', '--quiet', 'master');

  assert.deepEqual(pre(dir, 'Bash', { command: 'gh pr create --head fixcrash/c0de' }), { exitCode: 0 });
  assert.deepEqual(pre(dir, 'mcp__github__create_pull_request', { head: 'fixcrash/c0de', base: 'master' }), { exitCode: 0 });
  denied(pre(dir, 'mcp__github__create_pull_request', { head: 'master', base: 'master' }));
  assert.match(denied(pre(dir, 'mcp__github__create_pull_request', { head: 'nope' })), /cannot find the commit of branch nope/);
});

test('checks the repository a command changes to before opening the pull request', (t) => {
  const outer = repo(t);
  const inner = join(outer, 'inner');
  sh(outer, 'mkdir', 'inner');
  initRepo(inner, { 'a.txt': 'a\n' });
  sh(inner, 'git', 'switch', '--quiet', '-c', 'fixcrash/c0de');

  assert.deepEqual(pre(outer, 'Bash', { command: 'gh pr create --fill' }, { session_id: 'another' }), { exitCode: 0 });
  denied(pre(outer, 'Bash', { command: 'cd inner && gh pr create --fill' }, { session_id: 'another' }));
});

test('keeps every tool out of .git/fixcrash', (t) => {
  const dir = repo(t);
  assert.match(denied(pre(dir, 'Write', { file_path: join(dir, '.git/fixcrash/receipts/a.json'), content: '{}' })), /only the fixcrash CLI writes there/);
  denied(pre(dir, 'Edit', { file_path: join(dir, '.git/fixcrash/events/i.json') }));
  denied(pre(dir, 'Bash', { command: `echo '{}' > ${dir}/.git/fixcrash/receipts/a.json` }));
  assert.deepEqual(pre(dir, 'Bash', { command: `tail ${dir}/.git/fixcrash/logs/a-base.log` }), { exitCode: 0 });
});

test('lets the reproducer write tests only', (t) => {
  const dir = repo(t);
  const asReproducer = { agent_type: 'fixcrash:reproducer' };

  assert.match(denied(pre(dir, 'Write', { file_path: join(dir, 'app/src/main/java/A.kt') }, asReproducer)), /writes tests only/);
  assert.deepEqual(pre(dir, 'Write', { file_path: join(dir, 'app/src/test/java/ATest.kt') }, asReproducer), { exitCode: 0 });
  assert.deepEqual(pre(dir, 'Edit', { file_path: join(dir, 'app/src/main/java/A.kt') }), { exitCode: 0 });
});

test('redacts an event result, records its expected failure, and marks the session', (t) => {
  const dir = repo(t);

  const out = JSON.parse(postEvents(dir).stdout!).hookSpecificOutput;

  const text: string = out.updatedToolOutput[0].text;
  assert.equal(out.updatedToolOutput.length, 1);
  assert.doesNotMatch(text, /user-0042|jane\.doe|203\.0\.113\.7|abc123def456/);
  assert.match(text, /symbol: com.example.app.profile.ProfileParser.parse/);
  assert.match(out.additionalContext, /Redacted personal data .*user 2/);
  assert.match(out.additionalContext, /Recorded the expected failure for issue 0000000000000000000000000000c0de: java.lang.NullPointerException at com.example.app.profile.ProfileParser.parse/);
  const record = readRecord(join(dir, '.git'), '0000000000000000000000000000c0de')!;
  assert.deepEqual(record.expectations.map((e) => [e.exception, e.frame]), [['java.lang.NullPointerException', 'com.example.app.profile.ProfileParser.parse']]);
  assert.deepEqual(record.versions, [{ display: '2.3', build: '230', revision: '1111111111111111111111111111111111111111' }]);
  assert.ok(existsSync(join(dir, '.git/fixcrash/sessions', SESSION)));
});

test('redacts other Crashlytics results without recording anything', (t) => {
  const dir = repo(t);
  const report = 'groups: |\n  - issue:\n      subtitle: java.lang.IllegalArgumentException - bad email jane@example.com\n';

  const out = handle({
    hook_event_name: 'PostToolUse', session_id: SESSION, cwd: dir, tool_name: 'mcp__firebase__crashlytics_get_report',
    tool_input: {}, tool_response: [{ type: 'text', text: report }],
  });

  assert.match(JSON.parse(out.stdout!).hookSpecificOutput.updatedToolOutput[0].text, /bad email <email>/);
  assert.equal(existsSync(join(dir, '.git/fixcrash/sessions')), false);
});

test('outside a git repository, redacts and says nothing was recorded', (t) => {
  const dir = tempDir(t);

  const out = JSON.parse(postEvents(dir).stdout!).hookSpecificOutput;

  assert.doesNotMatch(out.updatedToolOutput[0].text, /user-0042/);
  assert.match(out.additionalContext, /Not in a git repository/);
});

test('ignores tools and results it has nothing to do with', (t) => {
  const dir = repo(t);
  assert.deepEqual(handle({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Bash', tool_response: 'jane@example.com' }), { exitCode: 0 });
  assert.deepEqual(handle({
    hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'mcp__firebase__crashlytics_list_notes', tool_response: [{ type: 'text', text: 'notes: []' }],
  }), { exitCode: 0 });
  assert.deepEqual(pre(dir, 'Read', { file_path: join(dir, '.git/fixcrash/receipts/a.json') }), { exitCode: 0 });
});
