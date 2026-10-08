// Eval metrics (docs/PLAN.md, step 4), read from Claude Code session transcripts:
// wall and agent time, tool calls, what fixcrash reproduce and verify said, the
// pull request, hook denials, tokens. The transcript format is Claude Code's own
// and undocumented: see docs/RESEARCH.md §7 for what this relies on.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `usage: node eval/metrics.ts [--json] <session.jsonl | project dir>...
  A project directory stands for every session Claude Code recorded there.
  Prints a Markdown table, one row per session, or the full metrics with --json.`;

export interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  /** On a `continued-in` entry: the session the conversation went on in. */
  continuedInSessionId?: string;
  /** On a `cost-state` entry: the session's cost so far. */
  totalCostUSD?: number;
  isMeta?: boolean;
  origin?: { kind?: string };
  permissionDecision?: { decision?: string; source?: string };
  message?: { id?: string; model?: string; content?: unknown; usage?: Usage };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: unknown };
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: unknown;
}

export interface Subagent {
  type: string;
  entries: Entry[];
}

export interface SessionMetrics {
  session: string;
  /** Issue ids given to /fixcrash:fix. */
  issues: string[];
  start: string;
  end: string;
  wallMs: number;
  /** Time the agent or a subagent was working. Permission prompts happen inside tool calls, so they count here. */
  agentMs: number;
  /** wallMs - agentMs: waiting for the user's next message or answer, or for a background task to report. */
  idleMs: number;
  toolCalls: number;
  tools: Record<string, number>;
  toolErrors: number;
  /** Tool calls a PreToolUse hook refused: the PR guard, the state write ban. */
  hookDenials: number;
  subagents: { type: string; toolCalls: number }[];
  reproduce: { runs: number; reproduced: boolean };
  verify: { runs: number; verified: boolean };
  pr?: string;
  notes: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** As Claude Code reports it: includes calls the transcript doesn't show, such as the auto mode classifier. */
  costUsd: number;
  models: string[];
  /** Sessions the conversation was continued in, merged into this one. */
  continuedIn: string[];
}

/** One entry per line; a line that doesn't parse (still being written) is skipped. */
export function parseTranscript(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // skipped
    }
  }
  return entries;
}

function blocks(e: Entry): Block[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}

function time(e: Entry): number | undefined {
  const t = Date.parse(e.timestamp ?? '');
  return Number.isNaN(t) ? undefined : t;
}

/** A message the user typed. Tool results, task notifications and compaction summaries are not. */
const isHuman = (e: Entry) => e.type === 'user' && e.origin?.kind === 'human';

const isToolResult = (e: Entry) => e.type === 'user' && blocks(e).some((b) => b.type === 'tool_result');

const isLocalCommand = (e: Entry) => e.type === 'system' && e.subtype === 'local_command';

/** What a turn starts with: a typed message or local command (/login), a task notification, a compaction summary. */
const startsTurn = (e: Entry) => (e.type === 'user' && !e.isMeta && !isToolResult(e)) || isLocalCommand(e);

/** Entries that show the agent working: its messages, tool results, turn-end bookkeeping. */
const isActivity = (e: Entry) => e.type === 'assistant' || (e.type === 'system' && !isLocalCommand(e)) || isToolResult(e);

/** Total length of the union of spans. */
function covered(spans: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** Each session's last reported cost, summed over the sessions of a continued conversation. */
function costOf(entries: Entry[]): number {
  const bySession = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== 'cost-state' || typeof e.totalCostUSD !== 'number') continue;
    const id = e.sessionId ?? '';
    bySession.set(id, Math.max(bySession.get(id) ?? 0, e.totalCostUSD));
  }
  return [...bySession.values()].reduce((a, b) => a + b, 0);
}

export function sessionMetrics(session: string, main: Entry[], subagents: Subagent[]): SessionMetrics {
  const all = [main, ...subagents.map((s) => s.entries)];
  const human = main.filter(isHuman);

  const times = all.flat().map(time).filter((t) => t !== undefined);
  const first = human[0] ? time(human[0]) : undefined;
  const startMs = first ?? (times.length > 0 ? Math.min(...times) : 0);
  // The end of the work, not of the session: /exit typed later doesn't count.
  const busy = [...main.filter(isActivity), ...subagents.flatMap((s) => s.entries)].map(time).filter((t) => t !== undefined);
  const endMs = Math.max(startMs, ...busy);

  // In time order: a resumed session's file isn't.
  const timeline = main
    .map((e) => ({ e, t: time(e) }))
    .filter((x): x is { e: Entry; t: number } => x.t !== undefined && x.t >= startMs)
    .sort((a, b) => a.t - b.t);
  // Busy spans: each turn of the main agent, from its start to its last activity, and
  // each subagent from its first entry to its last. A background subagent works between turns.
  // A question the agent asks with AskUserQuestion pauses the turn until the answer comes back.
  const spans: [number, number][] = [];
  let turn: [number, number] | undefined;
  let asking: string | undefined;
  for (const { e, t } of timeline) {
    if (startsTurn(e)) {
      if (turn) spans.push(turn);
      turn = [t, t];
      asking = undefined;
    } else if (asking) {
      if (blocks(e).some((b) => b.type === 'tool_result' && b.tool_use_id === asking)) {
        turn = [t, t];
        asking = undefined;
      }
    } else if (isActivity(e) && turn) {
      turn[1] = t;
      asking = blocks(e).find((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion')?.id;
      if (asking) {
        spans.push(turn);
        turn = undefined;
      }
    }
  }
  if (turn) spans.push(turn);
  for (const s of subagents) {
    const ts = s.entries.map(time).filter((t) => t !== undefined);
    if (ts.length > 0) spans.push([Math.max(startMs, Math.min(...ts)), Math.max(...ts)]);
  }
  const agentMs = covered(spans);

  const issues: string[] = [];
  for (const e of human) {
    const m = /fixcrash:fix\b[\s\S]*?\b([0-9a-f]{32})\b/.exec(text(e.message?.content));
    if (m?.[1] && !issues.includes(m[1])) issues.push(m[1]);
  }

  const m: SessionMetrics = {
    session, issues, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    wallMs: endMs - startMs, agentMs, idleMs: endMs - startMs - agentMs,
    toolCalls: 0, tools: {}, toolErrors: 0, hookDenials: 0, subagents: [],
    reproduce: { runs: 0, reproduced: false }, verify: { runs: 0, verified: false }, notes: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: costOf(main), models: [], continuedIn: [],
  };

  const usage = new Map<string, Usage>();
  const models = new Set<string>();
  const countIn = (entries: Entry[]): number => {
    const uses = new Map<string, Block>();
    const results = new Map<string, { text: string; error: boolean }>();
    for (const e of entries) {
      if (e.type === 'assistant' && e.message?.id) {
        if (e.message.usage) usage.set(e.message.id, e.message.usage);
        if (e.message.model && e.message.model !== '<synthetic>') models.add(e.message.model);
      }
      if (e.permissionDecision?.decision === 'reject' && e.permissionDecision.source === 'hook') m.hookDenials++;
      for (const b of blocks(e)) {
        if (b.type === 'tool_use' && b.id) uses.set(b.id, b);
        if (b.type === 'tool_result' && b.tool_use_id) {
          results.set(b.tool_use_id, { text: text(b.content), error: b.is_error === true });
        }
      }
    }
    for (const [id, use] of uses) {
      const name = use.name ?? 'unknown';
      m.tools[name] = (m.tools[name] ?? 0) + 1;
      const result = results.get(id) ?? { text: '', error: false };
      if (result.error) m.toolErrors++;
      const command = name === 'Bash' && typeof use.input?.command === 'string' ? use.input.command : '';
      if (/\bfixcrash\s+reproduce\b/.test(command)) {
        m.reproduce.runs++;
        if (/^REPRODUCED at /m.test(result.text)) m.reproduce.reproduced = true;
      }
      if (/\bfixcrash\s+verify\b/.test(command)) {
        m.verify.runs++;
        if (/^VERIFIED: /m.test(result.text)) m.verify.verified = true;
      }
      if (/\bgh\s+pr\s+create\b/.test(command) && !result.error) {
        m.pr = /https:\/\/github\.com\/\S+?\/pull\/\d+/.exec(result.text)?.[0] ?? m.pr;
      }
      if (name.endsWith('crashlytics_create_note') && !result.error) m.notes++;
    }
    return uses.size;
  };

  m.toolCalls = countIn(main);
  for (const s of subagents) {
    const calls = countIn(s.entries);
    m.toolCalls += calls;
    m.subagents.push({ type: s.type, toolCalls: calls });
  }
  for (const u of usage.values()) {
    m.tokens.input += u.input_tokens ?? 0;
    m.tokens.output += u.output_tokens ?? 0;
    m.tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    m.tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  m.models = [...models].sort();
  return m;
}

function subagentsOf(file: string): Subagent[] {
  const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => {
    const meta = join(dir, f.replace(/\.jsonl$/, '.meta.json'));
    const type = existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as { agentType?: string }).agentType : undefined;
    return { type: type ?? 'unknown', entries: parseTranscript(readFileSync(join(dir, f), 'utf8')) };
  });
}

const continuedIn = (entries: Entry[]) => entries.find((e) => e.type === 'continued-in')?.continuedInSessionId;

/**
 * A session file, with its subagents from `<session>/subagents/agent-*.jsonl` and their
 * `.meta.json`. A session that was continued in another (`continued-in`) is merged with it:
 * the continuation repeats its entries, so they count once, by uuid.
 */
export function loadSession(file: string): SessionMetrics {
  // A copied entry carries the new session id: entries without a uuid are compared without it.
  const key = (e: Entry) => e.uuid ?? JSON.stringify({ ...e, sessionId: undefined });
  const files = [file];
  let entries = parseTranscript(readFileSync(file, 'utf8'));
  const seen = new Set(entries.map(key));
  const subagents = subagentsOf(file);
  for (let next = continuedIn(entries); next; ) {
    const path = join(dirname(file), `${next}.jsonl`);
    if (files.includes(path) || !existsSync(path)) break;
    files.push(path);
    const more = parseTranscript(readFileSync(path, 'utf8')).filter((e) => !seen.has(key(e)));
    for (const e of more) seen.add(key(e));
    entries = [...entries, ...more];
    subagents.push(...subagentsOf(path));
    next = continuedIn(more);
  }
  const m = sessionMetrics(basename(file, '.jsonl'), entries, subagents);
  m.continuedIn = files.slice(1).map((f) => basename(f, '.jsonl'));
  return m;
}

/** Where Claude Code keeps a project's sessions: its absolute path with non-alphanumerics as dashes. */
export function transcriptDir(projectDir: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  return join(configDir, 'projects', resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));
}

/** A project's sessions, without those that continue another: loadSession merges them in. */
function sessionFiles(projectDir: string): string[] {
  const dir = transcriptDir(projectDir);
  if (!existsSync(dir)) throw new Error(`no Claude Code sessions for ${projectDir}: ${dir} doesn't exist`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  const continuations = new Set(files.map((f) => continuedIn(parseTranscript(readFileSync(f, 'utf8')))).filter(Boolean));
  return files.filter((f) => !continuations.has(basename(f, '.jsonl')));
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;

export function table(rows: SessionMetrics[]): string {
  const head = ['Session', 'Issue', 'Wall', 'Agent', 'Tool calls', 'Reproduced', 'Verified', 'PR', 'Hook denials', 'Cost'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const m of rows) {
    const inSubagents = m.subagents.reduce((n, s) => n + s.toolCalls, 0);
    const cells = [
      m.session.slice(0, 8),
      m.issues.map((i) => i.slice(0, 8)).join(', ') || '-',
      duration(m.wallMs),
      duration(m.agentMs),
      `${m.toolCalls} (${inSubagents} in subagents)`,
      m.reproduce.runs > 0 ? `${m.reproduce.reproduced ? 'yes' : 'no'}, ${runs(m.reproduce.runs)}` : '-',
      m.verify.runs > 0 ? `${m.verify.verified ? 'yes' : 'no'}, ${runs(m.verify.runs)}` : '-',
      m.pr ?? 'none',
      String(m.hookDenials),
      `$${m.costUsd.toFixed(2)}`,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length === 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    const files = positionals.flatMap((p) => (p.endsWith('.jsonl') ? [p] : sessionFiles(p)));
    const rows = files.map(loadSession).sort((a, b) => a.start.localeCompare(b.start));
    console.log(values.json ? JSON.stringify(rows, null, 2) : table(rows));
    return 0;
  } catch (e) {
    console.error(`metrics: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
