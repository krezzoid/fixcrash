// The Release workflow's first step (.github/workflows/release.yml): the next
// version after the latest release tag, set in the plugin's manifest, and the
// changelog's Unreleased section moved under that version, dated. Prints the
// version and writes the section's text, the release notes, to <notes file>.
// The workflow commits, tags and publishes; this script changes two files only.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node scripts/release.ts <patch|minor|major> <notes file>';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MANIFEST = 'plugin/.claude-plugin/plugin.json';
export const CHANGELOG = 'CHANGELOG.md';
const UNRELEASED = '## Unreleased';

const BUMPS = ['patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];
type Version = [number, number, number];

function parse(version: string): Version | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The version after the latest `v<major>.<minor>.<patch>` tag, or after 0.0.0 when there is none. */
export function nextVersion(tags: string[], bump: Bump): string {
  const released = tags.map((tag) => (tag.startsWith('v') ? parse(tag.slice(1)) : undefined)).filter((v) => v !== undefined);
  const [major, minor, patch] = released.sort(compare).at(-1) ?? [0, 0, 0];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The manifest with `version` set and every other byte kept. Refuses to go below the version it has. */
export function setVersion(manifest: string, version: string): string {
  const current = (JSON.parse(manifest) as { version?: string }).version;
  const from = parse(current ?? '');
  if (!from) throw new Error(`${MANIFEST} has no version of the form 1.2.3: ${current}`);
  if (compare(parse(version)!, from) < 0) {
    throw new Error(`${MANIFEST} is at ${current}, ahead of ${version}, the next release after the latest tag`);
  }
  const updated = manifest.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  if ((JSON.parse(updated) as { version?: string }).version !== version) throw new Error(`cannot set version in ${MANIFEST}`);
  return updated;
}

/**
 * The changelog with its Unreleased section moved under `## <version> (<date>)`
 * and an empty Unreleased section above it, and that section's text as the notes.
 */
export function cutChangelog(changelog: string, version: string, date: string): { changelog: string; notes: string } {
  const heading = changelog.indexOf(`\n${UNRELEASED}\n`);
  if (heading < 0) throw new Error(`${CHANGELOG} has no "${UNRELEASED}" section`);
  const body = heading + UNRELEASED.length + 2;
  const next = changelog.indexOf('\n## ', body);
  const notes = changelog.slice(body, next < 0 ? undefined : next).trim();
  if (!notes) throw new Error(`nothing under "${UNRELEASED}" in ${CHANGELOG}: list the changes first`);
  const rest = next < 0 ? '' : `\n${changelog.slice(next + 1)}`;
  return {
    changelog: `${changelog.slice(0, heading + 1)}${UNRELEASED}\n\n## ${version} (${date})\n\n${notes}\n${rest}`,
    notes: `${notes}\n`,
  };
}

export function main(argv: string[], root = ROOT, today = new Date()): number {
  const [bump, notesFile] = argv;
  if (!BUMPS.includes(bump as Bump) || !notesFile || argv.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n');
    const version = nextVersion(tags, bump as Bump);
    const manifest = setVersion(readFileSync(join(root, MANIFEST), 'utf8'), version);
    const { changelog, notes } = cutChangelog(readFileSync(join(root, CHANGELOG), 'utf8'), version, today.toISOString().slice(0, 10));
    writeFileSync(join(root, MANIFEST), manifest);
    writeFileSync(join(root, CHANGELOG), changelog);
    writeFileSync(notesFile, notes);
    console.log(version);
    return 0;
  } catch (e) {
    console.error(`release: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
