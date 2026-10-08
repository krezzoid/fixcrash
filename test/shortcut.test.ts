import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findShortcuts, shortcutReason } from '../src/shortcut.ts';

const whats = (text: string) => findShortcuts('T.kt', text, 'all').map((s) => s.what);

test('each rule catches its shortcut, in Kotlin and in Java', () => {
  const cases: [string, RegExp][] = [
    ['val unsafeClass = Class.forName("sun.misc.Unsafe")', /Unsafe/],
    ['val field = unsafeClass.getDeclaredField("theUnsafe")', /Unsafe/],
    ['unsafe.allocateInstance(DetailsFragment::class.java)', /Unsafe/],
    ['import org.objenesis.ObjenesisStd', /Objenesis/],
    ['val f = ObjenesisStd().newInstance(DetailsFragment::class.java)', /Objenesis/],
    ['ReflectionFactory.getReflectionFactory().newConstructorForSerialization(c, o)', /serialization/],
    ['method.isAccessible = true', /private member through reflection/],
    ['method.setAccessible(true);', /private member through reflection/],
    ['if (method.trySetAccessible()) method.invoke(x)', /private member through reflection/],
    ['MethodHandles.privateLookupIn(DetailsFragment::class.java, MethodHandles.lookup())', /privateLookupIn/],
    ['Whitebox.invokeMethod(fragment, "onDetailsLoaded")', /Whitebox/],
  ];
  for (const [line, what] of cases) {
    const found = whats(line);
    assert.equal(found.length, 1, line);
    assert.match(found[0]!, what, line);
  }
});

test('lets ordinary test code through', () => {
  const text = [
    'val pager = FeedPager(items(23), pageSize = 10)',
    'val page = pager.page(2)',
    'assertEquals((21..23).toList(), page.map { it.id })',
    'val scenario = launchFragmentInContainer<DetailsFragment>()',
    'scenario.moveToState(Lifecycle.State.DESTROYED)',
    'val accessible = item.isAccessible',
  ].join('\n');

  assert.deepEqual(whats(text), []);
});

test('ignores comments, and keeps line numbers', () => {
  const text = [
    '/**',
    ' * Not with sun.misc.Unsafe: method.isAccessible = true would prove nothing.',
    ' */',
    '// unsafe.allocateInstance(x)',
    'val f = unsafe.allocateInstance(DetailsFragment::class.java)',
  ].join('\n');

  assert.deepEqual(findShortcuts('T.kt', text, 'all'), [{ file: 'T.kt', line: 5, what: 'builds an object without its constructor (Unsafe)' }]);
});

test('looks only at the given lines', () => {
  const text = 'old.isAccessible = true\nval x = 1\nnew.isAccessible = true\n';

  assert.deepEqual(findShortcuts('T.kt', text, new Set([2, 3])).map((s) => s.line), [3]);
});

test('says where the shortcut is and what to do instead', () => {
  const reason = shortcutReason(findShortcuts('app/src/test/T.kt', 'val u = theUnsafe\nm.isAccessible = true\nn.isAccessible = true\n', 'all'));

  assert.match(reason, /^the test reaches the crash from a state the app is never in \(app\/src\/test\/T\.kt: builds an object without its constructor \(Unsafe\), line 1; opens a private member through reflection, lines 2, 3\)\. /);
  assert.match(reason, /report it as not reproduced and say what would \(for example Robolectric\)$/);
});
