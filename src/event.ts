// Crashlytics events as the Firebase MCP server prints them, and what
// fixcrash takes from them: the expected failure, the version, the build
// stamp revision. Also the redaction applied before the model sees them.
//
// The server (firebase-tools 15.32.1, src/mcp/tools/crashlytics/events.ts)
// prints `js-yaml.dump(events)`, where each event is a map from field name to
// a string: nested objects are YAML-dumped first, stack traces are text.

import type { CrashSite } from './stack.ts';

/** One top-level field of a printed event, with the lines it spans. */
interface Field {
  key: string;
  value: string;
  /** Line range in the printed text, header line included, end exclusive. */
  start: number;
  end: number;
}

const ITEM = /^(- |  )([A-Za-z_][\w]*):(?: (.*))?$/;

function unquoteSingle(s: string): string {
  return s.replace(/''/g, "'");
}

function unquoteDouble(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e[0] === 'x' || e[0] === 'u') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[e] ?? e;
  });
}

/** Folds YAML continuation lines: single newlines become spaces, blank lines become newlines. */
function fold(lines: string[]): string {
  let out = '';
  let blanks = 0;
  lines.forEach((l, i) => {
    if (l === '') {
      blanks++;
      return;
    }
    if (i > 0) out += blanks > 0 ? '\n'.repeat(blanks) : ' ';
    blanks = 0;
    out += l;
  });
  return out;
}

function blockScalar(header: string, body: string[]): string {
  const m = header.match(/^([|>])(\d)?([-+])?$|^([|>])([-+])(\d)$/);
  const style = m?.[1] ?? m?.[4] ?? '|';
  const chomp = m?.[3] ?? m?.[5] ?? '';
  const indicator = m?.[2] ?? m?.[6];
  const first = body.find((l) => l.trim() !== '');
  const indent = indicator ? 2 + Number(indicator) : first ? first.length - first.trimStart().length : 0;
  const lines = body.map((l) => l.slice(indent));
  while (lines.length > 0 && lines[lines.length - 1] === '' && chomp !== '+') lines.pop();
  const text = style === '|' ? lines.join('\n') : fold(lines);
  return chomp === '-' ? text : `${text}\n`;
}

function flowScalar(header: string, body: string[]): string {
  const raw = [header, ...body.map((l) => l.trim())];
  if (header.startsWith("'")) return unquoteSingle(fold(raw).slice(1, -1));
  if (header.startsWith('"')) return unquoteDouble(fold(raw).slice(1, -1));
  return fold(raw);
}

/** Splits printed events into their fields. Unknown shapes are skipped, not guessed. */
export function parseEvents(text: string): Field[][] {
  const lines = text.split('\n');
  const events: Field[][] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(ITEM);
    if (!m) {
      i++;
      continue;
    }
    if (m[1] === '- ' || events.length === 0) events.push([]);
    const start = i;
    const header = m[3] ?? '';
    i++;
    const body: string[] = [];
    // A field's value continues on lines indented deeper than its key, and on blank lines.
    while (i < lines.length && (lines[i] === '' || /^ {3,}/.test(lines[i]!)) && !ITEM.test(lines[i]!)) {
      body.push(lines[i]!);
      i++;
    }
    while (body.length > 0 && body[body.length - 1] === '' && i < lines.length) {
      body.pop();
      i--;
    }
    const value = /^[|>]/.test(header) ? blockScalar(header, body) : flowScalar(header, body);
    events[events.length - 1]!.push({ key: m[2]!, value, start, end: i });
  }
  return events;
}

/** A flat YAML map printed by js-yaml, such as `blameFrame` or `version`: top-level scalars only. */
export function parseFlatMap(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w.-]*): (.*)$/);
    if (!m) continue;
    const v = m[2]!;
    if (v.startsWith("'") && v.endsWith("'")) map[m[1]!] = unquoteSingle(v.slice(1, -1));
    else if (v.startsWith('"') && v.endsWith('"')) map[m[1]!] = unquoteDouble(v.slice(1, -1));
    else map[m[1]!] = v;
  }
  return map;
}

export interface EventFrame {
  symbol: string;
  file?: string;
  line?: number;
}

export interface EventThrowable {
  type: string;
  message: string;
  frames: EventFrame[];
}

/** The `exceptions` field: `Type: message`, `at symbol (File.kt:12)` lines, `Caused by:` sections. */
export function parseEventExceptions(text: string): EventThrowable[] {
  const chain: EventThrowable[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === '... frames omitted ...') continue;
    const frame = line.match(/^at (\S+)(?: \(([^:)]+)(?::(\d+))?\))?$/);
    if (frame && chain.length > 0) {
      const f: EventFrame = { symbol: frame[1]! };
      if (frame[2]) f.file = frame[2];
      if (frame[3]) f.line = Number(frame[3]);
      chain[chain.length - 1]!.frames.push(f);
      continue;
    }
    const header = line.replace(/^Caused by: /, '').match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+): ?(.*)$/);
    if (header && (chain.length === 0 || line.startsWith('Caused by: '))) {
      chain.push({ type: header[1]!, message: header[2]!, frames: [] });
    } else if (chain.length > 0 && chain[chain.length - 1]!.frames.length === 0) {
      chain[chain.length - 1]!.message += `\n${raw}`;
    }
  }
  return chain;
}

export interface CrashEvent {
  name: string;
  issueId: string;
  issueTitle: string;
  errorType: string;
  /** `ANDROID`, `IOS`, … */
  platform?: string;
  /** Apple platforms: the Mach exception or signal in the issue subtitle, e.g. `EXC_BREAKPOINT`. */
  machException?: string;
  variant?: string;
  version?: { display: string; build: string };
  /** The git commit the build was made from, from the build stamp. */
  revision?: string;
  blameFrame?: EventFrame;
  /** Apple platforms: where the blame frame's crash is in the shipped binary. */
  site?: CrashSite;
  exceptions: EventThrowable[];
}

export interface Expectation {
  exception: string;
  frame: string;
  /** Apple platforms: where the crash is in the shipped binary, to recover the frames inlined into `frame`. */
  site?: CrashSite;
}

const APPLE_PLATFORMS = new Set(['IOS', 'MACOS', 'TVOS']);
const MACH_EXCEPTION = /^(EXC_[A-Z_]+|SIG[A-Z]+)\b/;

export function toCrashEvent(fields: Field[]): CrashEvent | undefined {
  const get = (k: string) => fields.find((f) => f.key === k)?.value;
  const issue = parseFlatMap(get('issue') ?? '');
  if (!issue.id) return undefined;
  const event: CrashEvent = {
    name: (get('name') ?? '').trim(),
    issueId: issue.id,
    issueTitle: issue.title ?? '',
    errorType: issue.errorType ?? '',
    exceptions: parseEventExceptions(get('exceptions') ?? ''),
  };
  const platform = (get('platform') ?? '').trim();
  if (platform) event.platform = platform;
  const mach = APPLE_PLATFORMS.has(platform) ? (issue.subtitle ?? '').match(MACH_EXCEPTION)?.[1] : undefined;
  if (mach) event.machException = mach;
  const variant = parseFlatMap(get('issueVariant') ?? '').id;
  if (variant) event.variant = variant;
  const version = parseFlatMap(get('version') ?? '');
  if (version.displayVersion !== undefined) event.version = { display: version.displayVersion, build: version.buildVersion ?? '' };
  const revision = (get('buildStamp') ?? '').match(/revision: "([0-9a-f]{40})"/);
  if (revision) event.revision = revision[1];
  const blame = parseFlatMap(get('blameFrame') ?? '');
  if (blame.symbol) {
    event.blameFrame = { symbol: blame.symbol };
    if (blame.file) event.blameFrame.file = blame.file;
    if (blame.line && /^\d+$/.test(blame.line)) event.blameFrame.line = Number(blame.line);
    if (mach && blame.library && blame.address && /^\d+$/.test(blame.address)) {
      const model = parseFlatMap(get('device') ?? '').model ?? '';
      event.site = { image: blame.library, address: Number(blame.address), simulator: /Simulator/.test(model) };
    }
  }
  return event;
}

/**
 * What a reproducing test must fail with: the blame frame, and the exception
 * whose stack holds it. When the frame is in a cause (`RuntimeException:
 * Unable to start activity` caused by the real one), the deepest such cause
 * wins: Crashlytics groups the issue by it, and a JVM test throws it directly.
 *
 * An Apple crash has no exceptions, only the Mach exception in the issue
 * subtitle (`EXC_BREAKPOINT` for every Swift runtime trap), and the blame
 * frame's address: with the crashing build's debug symbols, it recovers the
 * frames that the optimizer inlined into the blame frame (ADR-0002).
 */
export function expectationOf(event: CrashEvent): Expectation | undefined {
  const frame = event.blameFrame?.symbol;
  if (!frame) return undefined;
  if (event.exceptions.length === 0) {
    if (!event.machException) return undefined;
    return event.site ? { exception: event.machException, frame, site: event.site } : { exception: event.machException, frame };
  }
  const holding = event.exceptions.filter((t) => t.frames.some((f) => f.symbol === frame));
  const thrown = holding[holding.length - 1] ?? event.exceptions[event.exceptions.length - 1]!;
  return { exception: thrown.type, frame };
}

// --- Redaction ---------------------------------------------------------------

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: string;
}

/**
 * Patterns for personal data and secrets in free text: exception messages,
 * logs, breadcrumbs, custom keys, notes. Each rule has a test.
 */
export const RULES: RedactionRule[] = [
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: '<email>' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replace: '<token>' },
  { name: 'bearer', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: '$1 <token>' },
  {
    name: 'secret-assignment',
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|session[_-]?id)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
    replace: '$1$2<redacted>',
  },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: '<token>' },
  { name: 'aws-access-key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '<token>' },
  { name: 'uuid', pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, replace: '<uuid>' },
  { name: 'ipv4', pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, replace: '<ip>' },
  {
    name: 'ipv6',
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?/g,
    replace: '<ip>',
  },
  { name: 'phone', pattern: /\+\d[\d ().-]{7,}\d/g, replace: '<phone>' },
];

export function redactText(text: string, counts?: Map<string, number>): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args) => {
      counts?.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
      const groups = args.slice(1, -2) as string[];
      return rule.replace.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '');
    });
  }
  return out;
}

/** Fields that identify the user or the install: their values are dropped whole. */
const IDENTITY_FIELDS = new Set(['user', 'installationUuid']);

/**
 * Redacts printed Crashlytics output before the model sees it. Identity
 * fields of events lose every value; everything else goes through the
 * free-text rules, which leave ids, resource names, frames and shas alone.
 */
export function redactToolOutput(text: string): { text: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const lines = text.split('\n');
  for (const event of parseEvents(text)) {
    for (const field of event) {
      if (!IDENTITY_FIELDS.has(field.key)) continue;
      for (let i = field.start; i < field.end; i++) {
        const line = lines[i]!;
        if (i === field.start) {
          // `  user: |` keeps its header; an inline value is replaced.
          const m = line.match(/^(- |  )(\w+):(?: (.*))?$/)!;
          if (m[3] && !/^[|>]/.test(m[3])) {
            lines[i] = `${m[1]}${m[2]}: <redacted>`;
            counts.set(field.key, (counts.get(field.key) ?? 0) + 1);
          }
          continue;
        }
        if (['', '{}', '[]'].includes(line.trim())) continue;
        const kv = line.match(/^(\s+)([\w.-]+): /);
        lines[i] = kv ? `${kv[1]}${kv[2]}: <redacted>` : `${line.match(/^\s*/)![0]}<redacted>`;
        counts.set(field.key, (counts.get(field.key) ?? 0) + 1);
      }
    }
  }
  return { text: redactText(lines.join('\n'), counts), counts };
}
