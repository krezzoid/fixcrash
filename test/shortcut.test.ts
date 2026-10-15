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

test('each rule catches its shortcut, in Swift', () => {
  const cases: [string, RegExp][] = [
    ['method_exchangeImplementations(original, swizzled)', /swizzling/],
    ['method_setImplementation(method, imp)', /swizzling/],
    ['class_replaceMethod(UIApplication.self, selector, imp, types)', /swizzling/],
    ['@_dynamicReplacement(for: start(completion:))', /swizzling/],
    ['let vc = class_createInstance(DetailsViewController.self, 0)', /without its initializer/],
    ['let service = unsafeBitCast(pointer, to: SyncService.self)', /without its initializer/],
    ['service.perform(NSSelectorFromString("expire"))', /by selector/],
    ['service.perform(Selector(("expire")))', /by selector/],
    ['let handler = service.value(forKey: "expirationHandler")', /KVC/],
    ['service.setValue(nil, forKey: "upload")', /KVC/],
    ['let children = Mirror(reflecting: service).children', /Mirror/],
  ];
  for (const [line, what] of cases) {
    const found = findShortcuts('T.swift', line, 'all').map((s) => s.what);
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
    'let profile = try ProfileParser().parse(json)',
    'XCTAssertEqual(page.map(\\.id), Array(11...20))',
    'let vc = DetailsViewController(backend: backend)',
    'defaults.set(true, forKey: "onboarded")',
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
  assert.match(reason, /report it as not reproduced and say what would \(for example Robolectric, or a UI test\)$/);
});
