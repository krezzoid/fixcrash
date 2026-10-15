import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appIdsIn, plistString } from '../src/appid.ts';
import { tempDir, writeFiles } from './helpers.ts';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>API_KEY</key>
\t<string>not-a-real-key</string>
\t<key>BUNDLE_ID</key>
\t<string>com.example.app</string>
\t<key>GOOGLE_APP_ID</key>
\t<string>1:100000000001:ios:00000000000000bb</string>
</dict>
</plist>
`;

const JSON_CONFIG = JSON.stringify({
  client: [{ client_info: { mobilesdk_app_id: '1:100000000001:android:00000000000000aa', android_client_info: { package_name: 'com.example.app' } } }],
});

test('finds app ids in Android and Apple configs, and nothing else from them', (t) => {
  const dir = tempDir(t);
  writeFiles(dir, {
    'android/app/google-services.json': JSON_CONFIG,
    'ios/App/GoogleService-Info.plist': PLIST,
    'ios/build/GoogleService-Info.plist': PLIST.replace('00000000000000bb', '00000000000000cc'),
  });

  assert.deepEqual(appIdsIn(dir).sort((a, b) => a.file.localeCompare(b.file)), [
    { id: '1:100000000001:android:00000000000000aa', app: 'com.example.app', file: 'android/app/google-services.json' },
    { id: '1:100000000001:ios:00000000000000bb', app: 'com.example.app', file: 'ios/App/GoogleService-Info.plist' },
  ]);
});

test('reads a string from a property list', () => {
  assert.equal(plistString(PLIST, 'BUNDLE_ID'), 'com.example.app');
  assert.equal(plistString(PLIST, 'MISSING'), undefined);
  assert.equal(plistString('<key>A</key><string>x &amp; y</string>', 'A'), 'x & y');
});
