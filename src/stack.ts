// JVM stack traces, and the "same failure" check: a test counts as a
// reproduction only if it fails with the crash's exception type and the
// crash's top app frame is on the stack.

export interface Frame {
  /** `package.Class.method`, without class-loader or module prefixes; Swift: `Type.method(_:)`. */
  symbol: string;
  file?: string;
  line?: number;
  /** Apple crash logs: the binary the frame's code is in, e.g. `AppTests`. */
  image?: string;
}

export interface Throwable {
  type: string;
  message: string;
  frames: Frame[];
  relation: 'top' | 'cause' | 'suppressed';
}

/** What the crash looked like, from the Crashlytics event. */
export interface Expected {
  /** Exception class, e.g. `java.lang.NullPointerException`. */
  exception: string;
  /** Blame frame symbol, e.g. `com.example.ProfileParser.parse`. */
  frame: string;
  /** Apple platforms: where the crash is in the shipped binary (ADR-0002). */
  site?: CrashSite;
}

/** Apple platforms: a crash's place in the shipped binary, to recover the frames inlined into the blame frame. */
export interface CrashSite {
  /** The binary, e.g. `App`: the event's `blameFrame.library`. */
  image: string;
  /** Offset of the crash in it. */
  address: number;
  /** Built for the simulator rather than a device. */
  simulator: boolean;
}

export type MatchResult =
  | { ok: true; throwable: Throwable; frameIndex: number }
  | { ok: false; reason: string };

const HEADER = /^(Caused by|Suppressed): (.*)$/;
const TYPE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?::\s?([\s\S]*))?$/;
const FRAME = /^at\s+(\S+?)(?:\((.*)\))?$/;
const MORE = /^\.\.\. (\d+) more$/;

function parseFrame(raw: string, location: string | undefined): Frame {
  // JDK 9+ prefixes frames with `classloader/module@version/`, e.g. `java.base/` or `app//`.
  const symbol = raw.slice(raw.lastIndexOf('/') + 1);
  const frame: Frame = { symbol };
  const loc = location?.match(/^([^:]+?)(?::(\d+))?$/);
  if (loc && loc[1] !== 'Unknown Source' && loc[1] !== 'Native Method') {
    frame.file = loc[1];
    if (loc[2]) frame.line = Number(loc[2]);
  }
  return frame;
}

function parseHeader(text: string, relation: Throwable['relation']): Throwable | undefined {
  const m = text.match(TYPE);
  if (!m) return undefined;
  return { type: m[1]!, message: m[2] ?? '', frames: [], relation };
}

/**
 * Parses a JVM stack trace as printed by `Throwable.printStackTrace()`, with
 * `Caused by:` and `Suppressed:` sections. Frames a cause shares with its
 * enclosing throwable (`... N more`) are restored, so each throwable has its
 * full stack. Everything printed inside a `Suppressed:` block, its own causes
 * included, is marked `suppressed`: it is not in the main cause chain.
 */
export function parseJvmStack(text: string): Throwable[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const result: Throwable[] = [];
  // For `... N more`: a cause shares its last N frames with the previous throwable in the chain.
  const enclosing = new Map<Throwable, Throwable>();
  let current: Throwable | undefined;
  let lastCausal: Throwable | undefined;
  let inMessage = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (current === undefined) {
      if (line === '') continue;
      current = parseHeader(line, 'top');
      if (!current) return [];
      result.push(current);
      lastCausal = current;
      inMessage = true;
      continue;
    }
    const header = line.match(HEADER);
    if (header) {
      // Main-chain causes start at column 0; suppressed blocks are indented.
      const indented = rawLine !== rawLine.trimStart();
      const relation = header[1] === 'Caused by' && !indented ? 'cause' : 'suppressed';
      const next = parseHeader(header[2]!, relation);
      if (next) {
        if (relation === 'cause' && lastCausal) {
          enclosing.set(next, lastCausal);
          lastCausal = next;
        }
        current = next;
        result.push(current);
        inMessage = true;
        continue;
      }
    }
    const frame = line.match(FRAME);
    if (frame) {
      current.frames.push(parseFrame(frame[1]!, frame[2]));
      inMessage = false;
      continue;
    }
    const more = line.match(MORE);
    if (more) {
      const outer = enclosing.get(current);
      if (outer) current.frames.push(...outer.frames.slice(-Number(more[1])));
      inMessage = false;
      continue;
    }
    if (inMessage) current.message += `\n${rawLine}`;
  }
  return result;
}

/** Package path of a frame symbol: the segments before the first capitalised one. */
function packagePath(symbol: string): string | undefined {
  const parts = symbol.split('.');
  const cls = parts.findIndex((p) => /^[A-Z]/.test(p));
  if (cls <= 0) return undefined;
  return parts.slice(0, cls).join('/');
}

/**
 * A frame belongs to test code if its source file is one of the test files.
 * Frames carry only a file name, so the package path disambiguates files with
 * the same name in app and test sources.
 */
export function testFrameDetector(testFiles: string[]): (frame: Frame) => boolean {
  const paths = testFiles.map((f) => `/${f}`);
  return (frame) => {
    if (!frame.file) return false;
    const pkg = packagePath(frame.symbol);
    const suffix = pkg ? `/${pkg}/${frame.file}` : `/${frame.file}`;
    return paths.some((p) => p.endsWith(suffix));
  };
}

export function formatFrame(f: Frame): string {
  if (!f.file) return f.symbol;
  return f.line === undefined ? `${f.symbol}(${f.file})` : `${f.symbol}(${f.file}:${f.line})`;
}

/** Optimized Swift code names a generic specialization `specialized <symbol>`; a Debug build doesn't. */
export function sameSymbol(a: string, b: string): boolean {
  const plain = (s: string) => s.replace(/^specialized /, '');
  return plain(a) === plain(b);
}

/**
 * Checks that a failure is the crash: some throwable in the cause chain has the
 * expected type, the expected frame is on its stack, and no frame above it is
 * test code (an exception thrown by a fake or a stub is not the crash).
 */
export function matchFailure(
  chain: Throwable[],
  expected: Expected,
  isTestFrame: (frame: Frame) => boolean,
): MatchResult {
  const causal = chain.filter((t) => t.relation !== 'suppressed');
  if (causal.length === 0) return { ok: false, reason: 'no stack trace in the failure' };
  const sameType = causal.filter((t) => t.type === expected.exception);
  if (sameType.length === 0) {
    const types = causal.map((t) => t.type).join(' <- ');
    return { ok: false, reason: `failed with ${types}, not ${expected.exception}` };
  }
  let reason = '';
  for (const t of sameType) {
    const i = t.frames.findIndex((f) => sameSymbol(f.symbol, expected.frame));
    if (i < 0) {
      reason = `${expected.exception} does not pass through ${expected.frame}`;
      continue;
    }
    const fromTest = t.frames.slice(0, i).find(isTestFrame);
    if (fromTest) {
      reason = `${expected.exception} is thrown from test code at ${formatFrame(fromTest)}, above ${expected.frame}`;
      continue;
    }
    return { ok: true, throwable: t, frameIndex: i };
  }
  return { ok: false, reason };
}
