// Reads JUnit XML test reports: the format Gradle writes natively, and Jest
// (jest-junit) and Xcode (xcresult converters) can write too.

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestFailure {
  /** Exception class from the `type` attribute, if the tool wrote one. */
  type: string;
  message: string;
  /** Element body: for JVM tools, the full stack trace. */
  text: string;
}

export interface TestCase {
  classname: string;
  name: string;
  status: TestStatus;
  failure?: TestFailure;
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** A minimal XML parser: elements, attributes, text and CDATA. Enough for JUnit reports. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let last = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    top.text += decodeEntities(xml.slice(last, m.index));
    last = m.index + m[0].length;
    const [token, cdata, closing, name, rawAttrs, selfClosing] = m;
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (name === undefined || token.startsWith('<!') || token.startsWith('<?')) {
      continue;
    } else if (closing) {
      if (top.name !== name) throw new Error(`malformed XML: </${name}> closes <${top.name}>`);
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const a of (rawAttrs ?? '').matchAll(ATTR)) {
        attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
      }
      const el: XmlElement = { name, attrs, children: [], text: '' };
      top.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length !== 1) throw new Error(`malformed XML: <${stack[stack.length - 1]!.name}> is not closed`);
  return root;
}

function* descendants(el: XmlElement, name: string): Generator<XmlElement> {
  for (const child of el.children) {
    if (child.name === name) yield child;
    else yield* descendants(child, name);
  }
}

/** All test cases in one JUnit XML document. */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const tc of descendants(parseXml(xml), 'testcase')) {
    const classname = tc.attrs.classname ?? '';
    const name = tc.attrs.name ?? '';
    const bad = tc.children.find((c) => c.name === 'failure' || c.name === 'error');
    if (bad) {
      cases.push({
        classname,
        name,
        status: 'failed',
        failure: { type: bad.attrs.type ?? '', message: bad.attrs.message ?? '', text: bad.text },
      });
    } else if (tc.children.some((c) => c.name === 'skipped')) {
      cases.push({ classname, name, status: 'skipped' });
    } else {
      cases.push({ classname, name, status: 'passed' });
    }
  }
  return cases;
}

/**
 * Test cases selected by a test id: `Class.method` matches that method (and its
 * parameterized variants, `method[0]`); `Class` matches every method of the class.
 */
export function selectCases(cases: TestCase[], testId: string): TestCase[] {
  const byClass = cases.filter((c) => c.classname === testId);
  if (byClass.length > 0) return byClass;
  const dot = testId.lastIndexOf('.');
  if (dot < 0) return [];
  const cls = testId.slice(0, dot);
  const method = testId.slice(dot + 1);
  return cases.filter(
    (c) => c.classname === cls && (c.name === method || c.name.startsWith(`${method}[`)),
  );
}
