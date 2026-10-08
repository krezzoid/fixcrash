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
  timestamp?: string;
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
  /** Time between turns: waiting for the user's next message, or for a background task to report. */
  idleMs: number;
  /** wallMs - idleMs. Permission prompts happen inside tool calls, so they stay in here. */
  agentMs: number;
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
  models: string[];
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

/** What a turn starts with: a typed message, a task notification, a compaction summary. */
const startsTurn = (e: Entry) => e.type === 'user' && !e.isMeta && !isToolResult(e);

/** Entries that show the agent working: its messages, tool results, turn-end hooks. */
const isActivity = (e: Entry) => e.type === 'assistant' || e.type === 'system' || isToolResult(e);

export function sessionMetrics(session: string, main: Entry[], subagents: Subagent[]): SessionMetrics {
  const all = [main, ...subagents.map((s) => s.entries)];
  const human = main.filter(isHuman);

  const times = all.flat().map(time).filter((t) => t !== undefined);
  const first = human[0] ? time(human[0]) : undefined;
  const startMs = first ?? (times.length > 0 ? Math.min(...times) : 0);
  const endMs = times.length > 0 ? Math.max(...times) : startMs;

  // In time order: a resumed session's file isn't.
  const timeline = main
    .map((e) => ({ e, t: time(e) }))
    .filter((x): x is { e: Entry; t: number } => x.t !== undefined && x.t >= startMs)
    .sort((a, b) => a.t - b.t);
  let idleMs = 0;
  let lastActivity: number | undefined;
  for (const { e, t } of timeline) {
    if (startsTurn(e)) {
      if (lastActivity !== undefined) idleMs += Math.max(0, t - lastActivity);
      lastActivity = t;
    } else if (isActivity(e)) {
      lastActivity = t;
    }
  }

  const issues: string[] = [];
  for (const e of human) {
    const m = /fixcrash:fix\b[\s\S]*?\b([0-9a-f]{32})\b/.exec(text(e.message?.content));
    if (m?.[1] && !issues.includes(m[1])) issues.push(m[1]);
  }

  const m: SessionMetrics = {
    session, issues, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    wallMs: endMs - startMs, idleMs, agentMs: endMs - startMs - idleMs,
    toolCalls: 0, tools: {}, toolErrors: 0, hookDenials: 0, subagents: [],
    reproduce: { runs: 0, reproduced: false }, verify: { runs: 0, verified: false }, notes: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, models: [],
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

/** A session file, with its subagents from `<session>/subagents/agent-*.jsonl` and their `.meta.json`. */
export function loadSession(file: string): SessionMetrics {
  const session = basename(file, '.jsonl');
  const dir = join(dirname(file), session, 'subagents');
  const subagents = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => {
      const meta = join(dir, f.replace(/\.jsonl$/, '.meta.json'));
      const type = existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as { agentType?: string }).agentType : undefined;
      return { type: type ?? 'unknown', entries: parseTranscript(readFileSync(join(dir, f), 'utf8')) };
    })
    : [];
  return sessionMetrics(session, parseTranscript(readFileSync(file, 'utf8')), subagents);
}

/** Where Claude Code keeps a project's sessions: its absolute path with non-alphanumerics as dashes. */
export function transcriptDir(projectDir: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  return join(configDir, 'projects', resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-'));
}

function sessionFiles(projectDir: string): string[] {
  const dir = transcriptDir(projectDir);
  if (!existsSync(dir)) throw new Error(`no Claude Code sessions for ${projectDir}: ${dir} doesn't exist`);
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;

export function table(rows: SessionMetrics[]): string {
  const head = ['Session', 'Issue', 'Wall', 'Agent', 'Tool calls', 'Reproduced', 'Verified', 'PR', 'Hook denials', 'Output tokens'];
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
      String(m.tokens.output),
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
