import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Entry, loadSession, parseTranscript, sessionMetrics, table, transcriptDir } from '../eval/metrics.ts';
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

test('finds a project directory under the config directory, every non-alphanumeric as a dash', () => {
  assert.equal(transcriptDir('/private/tmp/x.y/-z', '/home/u/.claude'), '/home/u/.claude/projects/-private-tmp-x-y--z');
});

test('prints one table row per session', () => {
  const out = table([sessionMetrics('0123456789', main, [{ type: 'fixcrash:reproducer', entries: reproducer }])]);

  assert.match(out, /^\| Session \| Issue \| Wall \| Agent \|/);
  assert.match(out, /\| 01234567 \| 01234567 \| 3m 23s \| 1m 13s \| 9 \(3 in subagents\) \| yes, 2 runs \| yes, 2 runs \| https:\/\/github.com\/example\/app\/pull\/7 \| 1 \| 100 \|/);
});
