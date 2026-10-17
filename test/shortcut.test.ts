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
    ['let lib = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW)', /libAccessibility/],
    ['let set = dlsym(handle, "_AXSApplicationAccessibilitySetEnabled")', /libAccessibility/],
    ['@_silgen_name("_AXSSetAutomationEnabled") func setAutomation(_ on: Int32)', /libAccessibility/],
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
    'XCTAssertFalse(UIAccessibility.isVoiceOverRunning)',
    'Button("Archive") { archive() }.accessibilityLabel("Archive")',
    'XCTAssertTrue(cell.accessibilityActivate())',
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
  assert.match(reason, /report it as not reproduced and say what would \(for example Robolectric, a UI test, or a test run on the app's JS engine\)$/);
});

test('each rule catches its shortcut, in JavaScript and TypeScript', () => {
  const cases: [string, RegExp][] = [
    ["jest.spyOn(global, 'Date').mockImplementation(() => new RealDate(NaN));", /swaps a global/],
    ['globalThis.Date = HermesDate;', /swaps a global/],
    ['window.Intl = undefined as never;', /swaps a global/],
    ['Date.prototype.toISOString = () => { throw new RangeError(); };', /replaces a method on a prototype/],
    ["jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => { throw new RangeError(); });", /prototype's method/],
    ["jest.spyOn(Date, 'parse').mockReturnValue(NaN);", /prototype's method/],
    ['const parser = Object.create(ProfileParser.prototype);', /without its constructor/],
    ["const parse = profileModule.__get__('parseProfile');", /rewire/],
    ["import rewire from 'rewire';", /rewire/],
  ];
  for (const [line, what] of cases) {
    const found = findShortcuts('t.test.ts', line, 'all').map((s) => s.what);
    assert.equal(found.length, 1, line);
    assert.match(found[0]!, what, line);
  }
});

test('lets ordinary JS test code through: time, randomness, spies and mocks of inputs', () => {
  const text = [
    "jest.spyOn(Date, 'now').mockReturnValue(1_792_000_000_000);",
    "jest.spyOn(Math, 'random').mockReturnValue(0.5);",
    'jest.useFakeTimers().setSystemTime(new Date(2026, 9, 16));',
    "jest.spyOn(console, 'error').mockImplementation(() => {});",
    "jest.spyOn(api, 'fetchInbox').mockResolvedValue({ items: [] });",
    "jest.mock('@react-native-firebase/crashlytics');",
    'const RealDate = global.Date;',
    'expect(global.Date === RealDate).toBe(true);',
    'const copy = Object.create(null);',
  ].join('\n');

  assert.deepEqual(findShortcuts('t.test.ts', text, 'all'), []);
});
