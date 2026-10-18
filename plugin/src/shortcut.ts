// A test can throw the crash's exception at the crash's frame from a state the
// app is never in: an object built without running its constructor, a private
// member called through reflection, a system method swapped for the test's own
// (swizzling: say, to call a background task's expiration handler while the
// app is in the foreground). Such a test proves nothing about the
// crash, so reproduce and verify refuse a test whose new lines take one of
// these shortcuts. The check reads source text: it stops a careless agent, not
// a determined one.

export interface Shortcut {
  /** Relative to the repository root. */
  file: string;
  line: number;
  what: string;
}

const RULES: { what: string; pattern: RegExp }[] = [
  { what: 'builds an object without its constructor (Unsafe)', pattern: /\b(?:sun|jdk\.internal)\.misc\.Unsafe\b|\btheUnsafe\b|\ballocateInstance\b/ },
  { what: 'builds an object without its constructor (Objenesis)', pattern: /\bobjenesis/i },
  { what: 'builds an object without its constructor (serialization)', pattern: /\bnewConstructorForSerialization\b/ },
  { what: 'opens a private member through reflection', pattern: /\bisAccessible\s*=\s*true\b|\bsetAccessible\s*\(\s*true\s*\)|\btrySetAccessible\s*\(/ },
  { what: 'opens a private member through reflection (privateLookupIn)', pattern: /\bprivateLookupIn\s*\(/ },
  { what: 'calls a private member through Whitebox', pattern: /\bWhitebox\s*\./ },
  // Swift and Objective-C.
  {
    what: 'swaps a method\'s implementation (swizzling)',
    pattern: /\b(?:method_exchangeImplementations|method_setImplementation|class_replaceMethod)\s*\(|@_dynamicReplacement\b/,
  },
  { what: 'builds an object without its initializer', pattern: /\bclass_createInstance\s*\(|\bunsafeBitCast\s*\(/ },
  { what: 'calls a private member by selector', pattern: /\bperform\s*\(\s*(?:NSSelectorFromString\s*\(|Selector\s*\(\s*\()/ },
  { what: 'reads or sets a private member by key (KVC)', pattern: /\.(?:value|setValue)\s*\([^)]*\bforKey(?:Path)?\s*:/ },
  { what: 'reads a private member through Mirror', pattern: /\bMirror\s*\(\s*reflecting\s*:/ },
  // A SwiftUI button's action can be run from a unit test once these turn accessibility on;
  // they are private, and stay on in the simulator for every later run (ADR-0003).
  { what: 'turns accessibility on through private libAccessibility functions', pattern: /\b_AXS\w+|\blibAccessibility\.dylib\b/ },
  // JavaScript and TypeScript (ADR-0004).
  { what: 'builds an object from its prototype without its constructor', pattern: /\bObject\.create\s*\(\s*[\w$.]+\.prototype\b/ },
  { what: "opens a module's internals (rewire)", pattern: /\b__(?:get|set|Rewire|ResetDependency|GetDependency)__\s*\(|['"](?:babel-plugin-)?rewire['"]/ },
  // A test that swaps a built-in reaches crashes that only another engine has (Hermes's Date
  // parser, say). Time and randomness stay the test's to control: Date.now, Math.random.
  {
    what: 'swaps a global for the test\'s own',
    pattern: /\bjest\.spyOn\(\s*(?:global|globalThis|window)\s*,\s*['"`][A-Z]\w*['"`]|\b(?:global|globalThis|window)\.[A-Z]\w*\s*=(?!=)/,
  },
  { what: 'replaces a method on a prototype', pattern: /\b[A-Z][\w$]*(?:\.[A-Z][\w$]*)?\.prototype\.[\w$]+\s*=(?!=)/ },
  {
    what: "swaps a built-in's or a prototype's method for the test's own",
    pattern: /\bjest\.spyOn\(\s*(?:(?:Date|Intl(?:\.\w+)?|Number|String|Array|Object|JSON|Promise|RegExp|Symbol|Reflect|Math)\s*,\s*['"`](?!now['"`]|random['"`])\w+['"`]|[A-Z][\w$]*(?:\.[A-Z][\w$]*)?\.prototype\s*,[^)]*)\)\s*\.mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)/,
  },
];

/** The source's lines with comments blanked out, so line numbers still match. */
function codeLines(text: string): string[] {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l));
}

/** The shortcuts a test file takes on `lines` (1-based), or anywhere with `'all'`. */
export function findShortcuts(file: string, text: string, lines: Set<number> | 'all'): Shortcut[] {
  const found: Shortcut[] = [];
  codeLines(text).forEach((code, i) => {
    if (lines !== 'all' && !lines.has(i + 1)) return;
    for (const r of RULES) if (r.pattern.test(code)) found.push({ file, line: i + 1, what: r.what });
  });
  return found;
}

export function shortcutReason(found: Shortcut[]): string {
  const byFile = new Map<string, Map<string, number[]>>();
  for (const s of found) {
    const whats = byFile.get(s.file) ?? new Map<string, number[]>();
    byFile.set(s.file, whats);
    whats.set(s.what, [...(whats.get(s.what) ?? []), s.line]);
  }
  const where = [...byFile]
    .map(([file, whats]) => `${file}: ${[...whats].map(([what, lines]) => `${what}, line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`).join('; ')}`)
    .join('; ');
  return `the test reaches the crash from a state the app is never in (${where}). ` +
    'Drive the code through its own entry points; if nothing else reaches the crashing line, ' +
    "report it as not reproduced and say what would (for example Robolectric, a UI test, or a test run on the app's JS engine)";
}
