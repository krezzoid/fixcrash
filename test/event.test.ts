import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  expectationOf, parseEventExceptions, parseEvents, parseFlatMap, redactText, redactToolOutput, RULES, toCrashEvent,
} from '../plugin/src/event.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/crashlytics/${name}`, import.meta.url), 'utf8');

test('splits a printed event into fields, decoding block and quoted scalars', () => {
  const [event, ...rest] = parseEvents(fixture('event-npe.yaml'));
  const get = (k: string) => event!.find((f) => f.key === k)?.value;

  assert.equal(rest.length, 0);
  assert.equal(get('platform'), 'ANDROID\n');
  assert.equal(get('eventId'), "'1000000000000000001'\n");
  assert.equal(get('breadcrumbs'), '[2026-01-01T09:59:57.000Z] screen_view { firebase_screen_class: MainActivity }');
  assert.match(get('logs')!, /^\[2026-01-01T09:59:58.000Z\] login ok for .*\n\[2026-01-01T09:59:59.000Z\] GET \/profile/);
  assert.equal(parseFlatMap(get('blameFrame')!).symbol, 'com.example.app.profile.ProfileParser.parse');
});

test('reads the crash: issue, version, build stamp revision, blame frame, exceptions', () => {
  const event = toCrashEvent(parseEvents(fixture('event-npe.yaml'))[0]!)!;

  assert.equal(event.issueId, '0000000000000000000000000000c0de');
  assert.equal(event.errorType, 'FATAL');
  assert.equal(event.variant, '00000000000000000000000000000002');
  assert.deepEqual(event.version, { display: '2.3', build: '230' });
  assert.equal(event.revision, '1111111111111111111111111111111111111111');
  assert.deepEqual(event.blameFrame, { symbol: 'com.example.app.profile.ProfileParser.parse', file: 'ProfileParser.kt', line: 12 });
  assert.equal(event.exceptions.length, 1);
  assert.deepEqual(event.exceptions[0]!.frames[0], { symbol: 'com.example.app.profile.ProfileParser.parse', file: 'ProfileParser.kt', line: 12 });
  assert.deepEqual(event.exceptions[0]!.frames.at(-1), { symbol: 'java.lang.reflect.Method.invoke', file: 'Method.java' });
  assert.deepEqual(expectationOf(event), { exception: 'java.lang.NullPointerException', frame: 'com.example.app.profile.ProfileParser.parse' });
});

test('expects the cause that holds the blame frame, not the wrapper', () => {
  const [first, second] = parseEvents(fixture('events-chained.yaml')).map((f) => toCrashEvent(f)!);

  assert.deepEqual(first!.exceptions.map((t) => t.type), ['java.lang.RuntimeException', 'java.lang.IllegalArgumentException']);
  assert.equal(first!.revision, undefined);
  assert.deepEqual(first!.version, { display: '2.4-beta', build: '241' });
  const expected = { exception: 'java.lang.IllegalArgumentException', frame: 'com.example.app.feed.FeedPager.<init>' };
  assert.deepEqual(expectationOf(first!), expected);
  assert.deepEqual(expectationOf(second!), expected);
});

test('has no expectation without a blame frame or exceptions', () => {
  const event = toCrashEvent(parseEvents(fixture('event-npe.yaml'))[0]!)!;

  assert.equal(expectationOf({ ...event, blameFrame: undefined }), undefined);
  assert.equal(expectationOf({ ...event, exceptions: [] }), undefined);
});

test('reads an iOS crash: Mach exception from the subtitle, blame frame with its address, no exceptions', () => {
  const event = toCrashEvent(parseEvents(fixture('event-ios.yaml'))[0]!)!;

  assert.equal(event.platform, 'IOS');
  assert.equal(event.machException, 'EXC_BREAKPOINT');
  assert.deepEqual(event.version, { display: '3.1', build: '310' });
  assert.equal(event.revision, undefined);
  assert.deepEqual(event.blameFrame, { symbol: 'ProfileViewController.showProfile()', file: 'Strings.swift', line: 7 });
  assert.deepEqual(event.site, { image: 'App', address: 29516, simulator: true });
  assert.deepEqual(event.exceptions, []);
  assert.deepEqual(expectationOf(event), {
    exception: 'EXC_BREAKPOINT', frame: 'ProfileViewController.showProfile()', site: { image: 'App', address: 29516, simulator: true },
  });
});

test('reads the Mach exception and the address on Apple platforms only', () => {
  const ios = toCrashEvent(parseEvents(fixture('event-ios.yaml'))[0]!)!;
  const android = toCrashEvent(parseEvents(fixture('event-ios.yaml').replace('    IOS\n', '    ANDROID\n'))[0]!)!;

  assert.equal(android.machException, undefined);
  assert.equal(android.site, undefined);
  assert.equal(expectationOf(android), undefined);
  assert.deepEqual(expectationOf({ ...ios, blameFrame: { symbol: 'A.b()' }, site: undefined }), { exception: 'EXC_BREAKPOINT', frame: 'A.b()' });
  const device = toCrashEvent(parseEvents(fixture('event-ios.yaml').replace('iOS Simulator (iPhone)', 'iPhone18,1'))[0]!)!;
  assert.equal(device.site?.simulator, false);
  assert.equal(expectationOf({ ...ios, machException: undefined }), undefined);
});

test('parses multi-line exception messages', () => {
  const [t] = parseEventExceptions('java.lang.IllegalStateException: first line\nsecond line\nat com.example.A.b (A.kt:1)');

  assert.equal(t!.message, 'first line\nsecond line');
  assert.equal(t!.frames.length, 1);
});

test('drops every value of the user and installation fields', () => {
  const { text, counts } = redactToolOutput(fixture('event-npe.yaml') + fixture('events-chained.yaml'));

  assert.doesNotMatch(text, /user-004[23]|jane\.doe|0{56}A{2}|0{56}B{2}/);
  assert.match(text, /  user: \|\n    id: <redacted>\n    email: <redacted>\n/);
  assert.match(text, /  installationUuid: \|\n    <redacted>\n/);
  assert.match(text, /  installationUuid: <redacted>\n/);
  assert.equal(counts.get('user'), 3);
  assert.equal(counts.get('installationUuid'), 2);
});

test('redacts personal data in free text and keeps ids, frames and shas', () => {
  const { text } = redactToolOutput(fixture('event-npe.yaml'));

  assert.match(text, /login ok for <email>/);
  assert.match(text, /Authorization: Bearer <token>/);
  assert.match(text, /client_ip: <ip>/);
  assert.match(text, /auth_token: <redacted>/);
  // Untouched: what the fix needs.
  for (const kept of [
    'id: 0000000000000000000000000000c0de',
    'events/0000000000000000000000000000000A_1000000000000000001',
    'apps/1:100000000001:android:00000000000000aa',
    'at com.example.app.profile.ProfileParser.parse (ProfileParser.kt:12)',
    'revision: "1111111111111111111111111111111111111111"',
    "[2026-01-01T09:59:57.000Z] screen_view { firebase_screen_class: MainActivity }",
  ]) {
    assert.ok(text.includes(kept), kept);
  }
  const event = toCrashEvent(parseEvents(text)[0]!)!;
  assert.deepEqual(expectationOf(event), { exception: 'java.lang.NullPointerException', frame: 'com.example.app.profile.ProfileParser.parse' });
});

test('redaction rules, one by one', () => {
  const cases: Record<string, [string, string][]> = {
    email: [['mail jane.doe+x@mail.example.co.uk now', 'mail <email> now']],
    jwt: [['t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end', 't=<token> end']],
    bearer: [['Authorization: Bearer abc.def-ghi_123', 'Authorization: Bearer <token>'], ['basic dXNlcjpwYXNz', 'basic <token>']],
    'secret-assignment': [
      ['password=hunter2 next', 'password=<redacted> next'],
      ['"api_key": "k-123"', '"api_key": "<redacted>"'],
      ['?session_id=abc&x=1', '?session_id=<redacted>&x=1'],
    ],
    'google-api-key': [[`key AIza${'A'.repeat(35)} end`, 'key <token> end']],
    'aws-access-key': [['id AKIAABCDEFGHIJKLMNOP end', 'id <token> end']],
    uuid: [['device 123e4567-e89b-12d3-a456-426614174000 lost', 'device <uuid> lost']],
    ipv4: [['from 192.168.0.12:443 ok', 'from <ip>:443 ok']],
    ipv6: [['from 2001:db8::8a2e:370:7334 ok', 'from <ip> ok'], ['fe80:0:0:0:200:f8ff:fe21:67cf', '<ip>']],
    phone: [['call +1 (555) 010-0199 now', 'call <phone> now']],
  };
  assert.deepEqual(Object.keys(cases).sort(), RULES.map((r) => r.name).sort(), 'every rule has a case');
  for (const [rule, pairs] of Object.entries(cases)) {
    for (const [input, output] of pairs) {
      const counts = new Map<string, number>();
      assert.equal(redactText(input, counts), output, `${rule}: ${input}`);
      assert.ok(counts.get(rule)! > 0, `${rule} counted`);
    }
  }
});

test('leaves code and crash metadata alone', () => {
  for (const s of [
    'at com.example.app.MainActivity$$ExternalSyntheticLambda6.run (D8$$SyntheticClass:4)',
    '[2026-10-07T19:10:55.327Z] action: open_profile',
    'crashlyticsSdkVersion: 20.1.1',
    'val x = Foo::class.java; std::vector<int>',
    'getToken() returned null',
    'projects/357943241138/apps/1:357943241138:android:1411f60e87427d13b59cab/events/6AC6993F022C00012F15CC161C001D46_2272451113638171026',
    'sessionsCount: 3',
  ]) {
    assert.equal(redactText(s), s);
  }
});
