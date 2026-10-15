// `fixcrash app-id`: the Firebase app ids in a project, from the config files
// the Firebase SDKs read: google-services.json (Android) and
// GoogleService-Info.plist (Apple). Only the id and the package or bundle id
// leave this module: both files also hold API keys.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeEntities } from './junit.ts';
import { findFiles } from './runner.ts';

export interface AppId {
  id: string;
  /** Android package name or Apple bundle id. */
  app: string;
  /** The config file, relative to the directory searched. */
  file: string;
}

interface GoogleServices {
  client?: { client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } } }[];
}

const ANDROID_CONFIG = 'google-services.json';
const APPLE_CONFIG = 'GoogleService-Info.plist';

/** A string value of a top-level key in an XML property list. */
export function plistString(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`));
  return m ? decodeEntities(m[1]!) : undefined;
}

export function appIdsIn(dir: string): AppId[] {
  const found: AppId[] = [];
  for (const file of findFiles(dir, new Set([ANDROID_CONFIG, APPLE_CONFIG]))) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (file.endsWith(APPLE_CONFIG)) {
      const id = plistString(text, 'GOOGLE_APP_ID');
      if (id) found.push({ id, app: plistString(text, 'BUNDLE_ID') ?? '', file });
      continue;
    }
    const config = JSON.parse(text) as GoogleServices;
    for (const c of config.client ?? []) {
      const id = c.client_info?.mobilesdk_app_id;
      if (id) found.push({ id, app: c.client_info?.android_client_info?.package_name ?? '', file });
    }
  }
  return found;
}
