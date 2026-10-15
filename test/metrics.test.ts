import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type Entry, loadSession, main as metricsMain, parseTranscript, runsFixcrash, sessionMetrics, table, transcriptDir,
} from '../eval/metrics.ts';
import { tempDir, writeFiles } from './helpers.ts';

const issue = '0123456789abcdef0123456789abcdef';
const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, s)).toISOString();

const human = (s: number, content: string): Entry => ({ type: 'user', timestamp: at(s), origin: { kind: 'human' }, message: { content } });

function call(s: number, msg: string, id: string, name: string, command: string, output = 10): Entry {
  return {
    type: 'assistant', timestamp: at(s),
    message: { id: msg, model: 'claude-test', content: [{ type: 'tool_use', id, name, input: { command } }], usage: { input_tokens: 1, output_tokens: output } },
  };
}

function result(s: number, id: string, text: string, extra: Partial<Entry> & { error?: boolean } = {}): Entry {
  const { error, ...rest } = extra;
  return { type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] }, ...rest };
}

const say = (s: number, msg: string): Entry => ({ type: 'assistant', timestamp: at(s), message: { id: msg, content: [{ type: 'text', text: 'synthetic' }], usage: { output_tokens: 5 } } });

const main: Entry[] = [
  { type: 'attachment', timestamp: at(0) },
  human(1, `<command-name>/fixcrash:fix</command-name>\n<command-args>${issue}</command-args>`),
  { type: 'user', timestamp: at(1), isMeta: true, message: { content: 'skill text' } },
  // One message, two lines: a thinking block, then the tool call. Its tokens count once.
  { type: 'assistant', timestamp: at(2), message: { id: 'm1', model: 'claude-test', content: [{ type: 'thinking' }], usage: { input_tokens: 1, output_tokens: 10 } } },
  call(2, 'm1', 't1', 'Agent', ''),
  result(40, 't1', 'REPRODUCED'),
  call(41, 'm2', 't2', 'Bash', 'git commit -m fix && fixcrash verify --issue x --test T.t --base abc'),
  result(51, 't2', 'NOT VERIFIED: the suite failed'),
  call(52, 'm3', 't3', 'Bash', 'fixcrash verify --issue x --test T.t --base abc'),
  result(62, 't3', 'running\nVERIFIED: receipt .git/fixcrash/receipts/c.json'),
  say(63, 'm4'),
  // 100 s with the user: idle.
  human(163, 'yes, open it'),
  call(164, 'm5', 't4', 'Bash', 'fixcrash pr-body | gh pr create --title t --body-file -'),
  result(165, 't4', 'refused by fixcrash', { error: true, permissionDecision: { decision: 'reject', source: 'hook' } }),
  call(166, 'm6', 't5', 'Bash', 'fixcrash pr-body | gh pr create --title t --body-file -'),
  result(170, 't5', 'https://github.com/example/app/pull/7\n'),
  // A background task reports after 30 s: idle too.
  { type: 'user', timestamp: at(200), origin: { kind: 'task-notification' }, message: { content: '<task-notification>' } },
  call(201, 'm7', 't6', 'mcp__plugin_fixcrash_firebase__crashlytics_create_note', ''),
  result(203, 't6', 'note created'),
  say(204, 'm8'),
];

const reproducer: Entry[] = [
  { type: 'user', timestamp: at(3), message: { content: 'brief' } },
  call(4, 's1', 'r1', 'Bash', 'fixcrash reproduce --issue x --test T.t --base abc --hypothesis h1'),
  result(14, 'r1', 'NOT REPRODUCED: the test passed. 4 attempts left'),
  call(15, 's2', 'r2', 'Write', ''),
  result(15, 'r2', 'ok'),
  call(16, 's3', 'r3', 'Bash', 'fixcrash reproduce --issue x --test T.t --base abc --hypothesis h2'),
  result(30, 'r3', 'REPRODUCED at abc1234: java.lang.NullPointerException at Parser.parse'),
];

test('times a session from the first typed message, without the waits between turns', () => {
  const m = sessionMetrics('s', main, [{ type: 'fixcrash:reproducer', entries: reproducer }]);

  assert.deepEqual(m.issues, [issue]);
  assert.equal(m.start, at(1));
  assert.equal(m.end, at(204));
  assert.equal(m.wallMs, 203_000);
  assert.equal(m.idleMs, 100_000 + 30_000);
  assert.equal(m.agentMs, 73_000);
});

test('counts a background subagent as working, and the wait for /login as idle', () => {
  const background: Entry[] = [
    human(0, `/fixcrash:fix ${issue}`),
    { type: 'assistant', timestamp: at(0), message: { id: 'e', model: '<synthetic>', content: [{ type: 'text', text: 'Login expired' }] } },
    { type: 'system', subtype: 'local_command', timestamp: at(40) },
    call(41, 'b1', 'u1', 'Agent', ''),
    result(42, 'u1', 'Async agent launched'),
    say(43, 'b2'),
    // The turn ends; the subagent works until 95 and its report arrives at 100.
    { type: 'user', timestamp: at(100), origin: { kind: 'task-notification' }, message: { content: '<task-notification>' } },
    say(101, 'b3'),
  ];
  const sub: Entry[] = [{ type: 'user', timestamp: at(42), message: { content: 'brief' } }, say(95, 's')];

  const m = sessionMetrics('s', background, [{ type: 'fixcrash:reproducer', entries: sub }]);

  assert.equal(m.wallMs, 101_000);
  assert.equal(m.agentMs, (95 - 40 + 1) * 1000);
  assert.equal(m.idleMs, (40 + 5) * 1000);
  assert.deepEqual(m.models, ['claude-test'], 'not <synthetic>');
});

test('counts tool calls with the subagents, and reads what fixcrash and gh said', () => {
  const m = sessionMetrics('s', main, [{ type: 'fixcrash:reproducer', entries: reproducer }]);

  assert.equal(m.toolCalls, 6 + 3);
  assert.deepEqual(m.subagents, [{ type: 'fixcrash:reproducer', toolCalls: 3 }]);
  assert.deepEqual(m.tools, { Agent: 1, Bash: 6, Write: 1, mcp__plugin_fixcrash_firebase__crashlytics_create_note: 1 });
  assert.deepEqual(m.reproduce, { runs: 2, reproduced: true });
  assert.deepEqual(m.verify, { runs: 2, verified: true });
  assert.equal(m.pr, 'https://github.com/example/app/pull/7');
  assert.equal(m.hookDenials, 1);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.notes, 1);
});

test('counts the tokens of a message once, however many lines it spans', () => {
  const m = sessionMetrics('s', main, [{ type: 'fixcrash:reproducer', entries: reproducer }]);

  assert.deepEqual(m.tokens, { input: 6 + 3, output: 6 * 10 + 2 * 5 + 3 * 10, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(m.models, ['claude-test']);
});

test('a run that never reproduced, verified or opened a PR says so', () => {
  const m = sessionMetrics('s', [human(0, `/fixcrash:fix ${issue}`), ...reproducer.slice(0, 3), say(20, 'x')], []);

  assert.deepEqual(m.reproduce, { runs: 1, reproduced: false });
  assert.deepEqual(m.verify, { runs: 0, verified: false });
  assert.equal(m.pr, undefined);
  assert.match(table([m]), /\| no, 1 run \| - \| none \| 0 \|/);
});

test('reads a session file and its subagents, skipping a line still being written', (t) => {
  const dir = tempDir(t);
  const lines = (es: Entry[]) => es.map((e) => JSON.stringify(e)).join('\n');
  writeFiles(dir, {
    'abc.jsonl': `${lines(main)}\n{"type":"assist`,
    'abc/subagents/agent-a1.jsonl': lines(reproducer),
    'abc/subagents/agent-a1.meta.json': JSON.stringify({ agentType: 'fixcrash:reproducer', toolUseId: 't1' }),
  });

  const m = loadSession(join(dir, 'abc.jsonl'));

  assert.equal(m.session, 'abc');
  assert.deepEqual(m.subagents, [{ type: 'fixcrash:reproducer', toolCalls: 3 }]);
  assert.equal(parseTranscript(`${lines(main)}\n{"type":"assist`).length, main.length);
  writeFileSync(join(dir, 'empty.jsonl'), '');
  assert.equal(loadSession(join(dir, 'empty.jsonl')).toolCalls, 0);
});

test('merges a session with the one it was continued in, counting copied entries once', (t) => {
  const config = tempDir(t);
  const project = '/work/app';
  const dir = transcriptDir(project, config);
  const stamp = (es: Entry[], sessionId: string) => es.map((e, i) => ({ ...e, sessionId, uuid: e.uuid ?? (e.type === 'cost-state' ? undefined : `u${i}`) }));
  const lines = (es: Entry[]) => es.map((e) => JSON.stringify(e)).join('\n');
  const first = stamp([
    human(0, `/fixcrash:fix ${issue}`),
    // The agent asks before pushing: the 10 s until the answer are the user's.
    call(1, 'm1', 'q1', 'AskUserQuestion', ''),
    result(11, 'q1', 'Push and open the PR'),
    call(12, 'm2', 'p1', 'Bash', 'fixcrash pr-body | gh pr create --title t --body-file -'),
    result(14, 'p1', 'https://github.com/example/app/pull/3'),
    say(15, 'm3'),
    { type: 'cost-state', totalCostUSD: 0.4 },
    { type: 'cost-state', totalCostUSD: 0.5 },
    { type: 'continued-in', timestamp: at(60), continuedInSessionId: 'second' },
  ], 'first');
  const second = [
    ...stamp(first.slice(0, -1), 'second'),
    // Typed after the work was done: not part of it.
    { type: 'user', timestamp: at(90), uuid: 'x1', sessionId: 'second', message: { content: '<command-name>/exit</command-name>' } },
    { type: 'cost-state', sessionId: 'second', totalCostUSD: 0.1 },
  ];
  writeFiles(dir, {
    'first.jsonl': lines(first),
    'second.jsonl': lines(second),
    'first/subagents/agent-a1.jsonl': lines([call(2, 's1', 'r1', 'Bash', 'ls'), result(3, 'r1', 'ok')]),
  });

  const m = loadSession(join(dir, 'first.jsonl'));

  assert.deepEqual(m.continuedIn, ['second']);
  assert.equal(m.wallMs, 15_000);
  assert.equal(m.agentMs, (1 + 1 + 4) * 1000);
  assert.equal(m.toolCalls, 3);
  assert.equal(m.pr, 'https://github.com/example/app/pull/3');
  assert.ok(Math.abs(m.costUsd - 0.6) < 1e-9, `cost ${m.costUsd}`);

  t.mock.method(console, 'log');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => (prev === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = prev)));
  assert.equal(metricsMain([project]), 0);
  const out = String((console.log as unknown as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls[0]?.arguments[0]);
  assert.match(out, /\| first \|/);
  assert.doesNotMatch(out, /\| second \|/, 'the continuation is merged, not a row of its own');
});

test('finds a project directory under the config directory, every non-alphanumeric as a dash', () => {
  assert.equal(transcriptDir('/private/tmp/x.y/-z', '/home/u/.claude'), '/home/u/.claude/projects/-private-tmp-x-y--z');
});

test('prints one table row per session', () => {
  const out = table([sessionMetrics('0123456789', main, [{ type: 'fixcrash:reproducer', entries: reproducer }])]);

  assert.match(out, /^\| Session \| Issue \| Wall \| Agent \|/);
  assert.match(out, /\| 01234567 \| 01234567 \| 3m 23s \| 1m 13s \| 9 \(3 in subagents\) \| yes, 2 runs \| yes, 2 runs \| https:\/\/github.com\/example\/app\/pull\/7 \| 1 \| \$0\.00 \|/);
});

test('counts a fixcrash run, not a mention of one in a commit message or a call for help', () => {
  const commit = "git add -A && git commit -q -F - <<'EOF'\nFix the crash\n\nfixcrash verify proves it.\nEOF";

  assert.equal(runsFixcrash('fixcrash verify --issue x --test T.t --base abc', 'verify'), true);
  assert.equal(runsFixcrash('git commit -m fix && fixcrash verify --issue x', 'verify'), true);
  assert.equal(runsFixcrash(`${commit}\nfixcrash verify --issue x`, 'verify'), true);
  assert.equal(runsFixcrash(commit, 'verify'), false);
  assert.equal(runsFixcrash('fixcrash verify --help 2>&1 | head -30', 'verify'), false);
  assert.equal(runsFixcrash('fixcrash reproduce --issue x', 'verify'), false);
});
